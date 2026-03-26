from .detector import PillDetector
from .gesture import GestureDetector
from .keyframe import KeyframeExtractor, VideoSource
import asyncio
import httpx
import json
import numpy as np
from datetime import datetime, timezone


# Confidence thresholds (from FE-7 in core module spec)
THRESHOLD_AUTO_VERIFY   = 0.85   # auto log, no user confirmation needed
THRESHOLD_CONFIRM       = 0.70   # ask user to confirm
THRESHOLD_DISCARD       = 0.70   # below this, discard silently


class MedicationDetectionPipeline:
    """
    Core detection pipeline combining:
    - YOLOv8 object detection (tablets and capsules)
    - MediaPipe gesture detection (grip + upward hand motion)
    - Temporal sequence analysis (phases: pill visible → hand grips → pill disappears)
    - Confidence scoring and event classification

    Uses temporal phase analysis instead of side-by-side scoring:
    the buffer is split into early/mid/late phases and the pipeline
    looks for the medication-taking SEQUENCE where pills appearing
    early and disappearing late is a positive indicator.
    """

    def __init__(self, api_base_url="http://localhost:5000"):
        self.detector  = PillDetector(model_path="ai/best_model.onnx")
        self.gesture   = GestureDetector()
        self.extractor = KeyframeExtractor(target_fps=10, buffer_seconds=10)
        self.api_base  = api_base_url
        self.is_running = False
        self.last_result = None  # Store last analysis result

    # ── Temporal Phase Helpers ─────────────────────────────────────────

    def _split_phases(self, items):
        """Split a list into three roughly equal temporal phases (early, mid, late)."""
        n = len(items)
        if n < 3:
            return items, items, items
        t1 = n // 3
        t2 = 2 * n // 3
        return items[:t1], items[t1:t2], items[t2:]

    def _avg_pill_score(self, phase_detections):
        """Average best-detection confidence across frames in a phase."""
        if not phase_detections:
            return 0.0
        scores = []
        for frame_result in phase_detections:
            if frame_result["detections"]:
                scores.append(max(d["confidence"] for d in frame_result["detections"]))
            else:
                scores.append(0.0)
        return float(np.mean(scores))

    def _avg_field(self, phase_results, field):
        """Average a numeric field across a list of gesture result dicts."""
        if not phase_results:
            return 0.0
        return float(np.mean([r[field] for r in phase_results]))

    def _peak_field(self, phase_results, field):
        """Peak value of a numeric field across a list of gesture result dicts."""
        if not phase_results:
            return 0.0
        return float(max(r[field] for r in phase_results))

    # ── Three-Phase Checklist Verification ────────────────────────────

    def compute_temporal_confidence(self, batch_detections, batch_gestures):
        """
        Three-phase checklist for medication intake verification.

        The buffer is split into three sections, each must be confirmed:

          Phase 1 — Medicine visible in hand
            Pill/tablet must be detected in the early frames.

          Phase 2 — Gripping medicine and moving toward mouth
            Hand grip or upward motion detected in mid frames.

          Phase 3 — Hand without medicine
            Pill is no longer visible in late frames (it was taken).

        Each phase produces a score (0.0 - 1.0). The final confidence
        is the average of all three — all must pass for high confidence.

        Returns (confidence, phase_details) tuple.
        """
        # Split both detection streams into temporal phases
        det_early, det_mid, det_late = self._split_phases(batch_detections)
        gest_early, gest_mid, gest_late = self._split_phases(batch_gestures)

        # ── Phase 1: Medicine visible in hand ─────────────────────────
        # Check: pills/tablets detected in early frames
        pill_early = self._avg_pill_score(det_early)
        hands_early = self._avg_field(gest_early, "hands_detected")

        # Medicine is visible if pill detection is strong
        # Bonus if a hand is also present (holding the pill)
        phase1_score = min(1.0, pill_early + (0.1 if hands_early > 0 else 0.0))
        phase1_pass = phase1_score >= 0.45

        # ── Phase 2: Gripping and moving toward mouth ─────────────────
        # Check: hand grip detected OR upward hand motion in mid frames
        grip_mid = max(
            self._avg_field(gest_early, "grip_confidence"),
            self._avg_field(gest_mid, "grip_confidence"),
        )
        motion_mid = max(
            self._peak_field(gest_mid, "upward_motion_score"),
            self._peak_field(gest_late, "upward_motion_score"),
        )

        # Either grip or motion confirms the hand is moving the pill
        phase2_score = min(1.0, max(grip_mid, motion_mid))
        phase2_pass = phase2_score >= 0.30

        # ── Phase 3: Hand without medicine (pill was taken) ───────────
        # Check: pill detection drops significantly in late frames
        pill_late = self._avg_pill_score(det_late)
        pill_drop = max(0.0, pill_early - pill_late)

        # Strong drop = medicine was consumed, not just moved away
        # Normalize: a full drop from 0.8+ to 0 = score 1.0
        phase3_score = min(1.0, pill_drop / 0.5) if pill_early > 0.3 else 0.0
        phase3_pass = phase3_score >= 0.50

        # ── Final Confidence ──────────────────────────────────────────
        # Average of all three phase scores — all must contribute
        phases_passed = sum([phase1_pass, phase2_pass, phase3_pass])
        confidence = (phase1_score + phase2_score + phase3_score) / 3.0

        # If fewer than 2 phases pass, cap confidence below threshold
        if phases_passed < 2:
            confidence = min(confidence, 0.40)

        phase_details = {
            "phase1_medicine_visible": {
                "score": round(phase1_score, 3),
                "pass": phase1_pass,
                "pill_score": round(pill_early, 3),
            },
            "phase2_grip_and_motion": {
                "score": round(phase2_score, 3),
                "pass": phase2_pass,
                "grip": round(grip_mid, 3),
                "motion": round(motion_mid, 3),
            },
            "phase3_medicine_gone": {
                "score": round(phase3_score, 3),
                "pass": phase3_pass,
                "pill_drop": round(pill_drop, 3),
            },
            "phases_passed": phases_passed,
        }

        return round(float(confidence), 3), phase_details

    def classify_event(self, confidence):
        """
        Classify event based on confidence thresholds from FE-7.
        Returns classification and recommended action.
        """
        if confidence >= THRESHOLD_AUTO_VERIFY:
            return {
                "classification": "auto_verified",
                "action": "log_automatically",
                "message": "Medication intake detected and automatically verified",
                "confidence": confidence
            }
        elif confidence >= THRESHOLD_CONFIRM:
            return {
                "classification": "needs_confirmation",
                "action": "request_user_confirmation",
                "message": "Possible medication intake detected. Please confirm.",
                "confidence": confidence
            }
        else:
            return {
                "classification": "unverified",
                "action": "discard",
                "message": "Detection confidence too low, event discarded",
                "confidence": confidence
            }

    def analyze_buffer(self):
        """
        Run full temporal-sequence analysis on the current keyframe buffer.

        Splits frames into early/mid/late phases and scores the
        medication-taking sequence pattern.  Returns detection result
        with per-phase breakdown, confidence score, and classification.
        """
        frames = self.extractor.get_frames_for_analysis()
        if not frames:
            return None

        # Run detectors across the full buffer (per-frame results)
        batch_detections = self.detector.detect_batch(frames)
        batch_gestures   = self.gesture.analyze_batch(frames)

        # Compute temporal confidence using phase analysis
        confidence, phase_details = self.compute_temporal_confidence(
            batch_detections, batch_gestures
        )

        # Classify the event
        classification = self.classify_event(confidence)

        # Collect frame quality stats from the buffer
        buffer = self.extractor.get_buffer()
        blur_scores = [kf.get("blur_score", 0) for kf in buffer]
        avg_blur = float(np.mean(blur_scores)) if blur_scores else 0.0

        result = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "final_confidence": confidence,
            "frames_analyzed": len(frames),
            "frame_quality": {
                "avg_blur_score": round(avg_blur, 2),
                "min_blur_score": round(min(blur_scores), 2) if blur_scores else 0,
                "all_frames_sharp": all(s >= 100 for s in blur_scores),
            },
            "phase_details": phase_details,
            "keyframe_buffer": [kf["id"] for kf in buffer],
            **classification
        }

        # Keep the BEST result (highest confidence) across all analysis batches.
        # The actual medication event may happen midway through the video —
        # later frames might show nothing and would otherwise overwrite the good result.
        if not self.last_result or result["final_confidence"] > self.last_result["final_confidence"]:
            self.last_result = result
        return result

    async def report_detection(self, result, user_id, medication_id, scheduled_time, token):
        """
        Send detection result to the Node.js dashboard backend API.
        Creates a medication log entry automatically or triggers confirmation notification.
        """
        if result["action"] == "discard":
            return  # Don't report low confidence detections

        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

        payload = {
            "medication_id": medication_id,
            "scheduled_time": scheduled_time,
            "status": "taken" if result["action"] == "log_automatically" else "scheduled",
            "verification_method": "visual",
            "confidence_score": result["final_confidence"],
            "keyframe_id": result["keyframe_buffer"][0] if result["keyframe_buffer"] else None,
            "notes": result["message"],
        }

        async with httpx.AsyncClient() as client:
            try:
                response = await client.post(
                    f"{self.api_base}/api/medications/logs",
                    json=payload,
                    headers=headers,
                    timeout=5.0
                )
                if response.status_code == 201:
                    print(f"Detection logged successfully: confidence={result['final_confidence']}")
                else:
                    print(f"API error: {response.status_code} - {response.text}")
            except Exception as e:
                print(f"Failed to report detection: {e}")

    def run_on_video(self, source=0, display=False):
        """
        Run the full pipeline on a video source.
        source=0 for webcam, or path to video file.
        Analyzes buffer every 10 seconds.
        """
        print(f"Starting medication detection pipeline on source: {source}")
        self.is_running = True

        import cv2
        import time
        cap = cv2.VideoCapture(source)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video source: {source}")

        frame_count = 0
        analyze_every = 30  # analyze buffer every 30 frames (works for short videos)

        try:
            while self.is_running:
                ret, frame = cap.read()
                if not ret:
                    print("End of video source")
                    self.is_running = False
                    # Auto-analyze whatever is in the buffer before stopping
                    try:
                        result = self.analyze_buffer()
                        if result:
                            print(f"\n=== Final Analysis (end of video) ===")
                            print(f"Frames: {result['frames_analyzed']} | Confidence: {result['final_confidence']}")
                            print(f"Classification: {result['classification']}")
                            print(f"====================================\n")
                    except Exception as e:
                        print(f"End-of-video analysis error: {e}")
                    break

                frame_count += 1

                # Yield the GIL so uvicorn can serve HTTP requests
                # Without this, the pipeline thread starves the event loop
                time.sleep(0.01)

                # Extract keyframe if appropriate
                keyframe = self.extractor.process_frame(frame)

                # Display annotated frame if debugging
                if display and keyframe:
                    detections = self.detector.detect(frame)
                    annotated = self.detector.annotate_frame(frame, detections)
                    cv2.imshow("LOCUS - Medication Detection", annotated)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break

                # Analyze buffer every N frames
                if frame_count % analyze_every == 0:
                    result = self.analyze_buffer()
                    if result:
                        pd = result.get("phase_details", {})
                        p1 = pd.get("phase1_medicine_visible", {})
                        p2 = pd.get("phase2_grip_and_motion", {})
                        p3 = pd.get("phase3_medicine_gone", {})
                        fq = result.get("frame_quality", {})
                        print(f"\n--- Detection Analysis ---")
                        print(f"Frames analyzed: {result['frames_analyzed']} | Avg blur: {fq.get('avg_blur_score', 0):.1f}")
                        print(f"Phase 1 (pill visible):  score={p1.get('score', 0):.2f}  pill={p1.get('pill_score', 0):.2f}")
                        print(f"Phase 2 (grip/motion):   score={p2.get('score', 0):.2f}  grip={p2.get('grip', 0):.2f}  motion={p2.get('motion', 0):.2f}")
                        print(f"Phase 3 (pill gone):     score={p3.get('score', 0):.2f}  drop={p3.get('pill_drop', 0):.2f}")
                        print(f"Phases passed:  {pd.get('phases_passed', 0)}/3")
                        print(f"Confidence:     {result['final_confidence']}")
                        print(f"Classification: {result['classification']}")
                        print(f"Action:         {result['action']}")
                        print(f"--------------------------\n")

        finally:
            cap.release()
            if display:
                cv2.destroyAllWindows()
            self.gesture.close()
            self.is_running = False
            # NOTE: buffer is intentionally NOT flushed here so
            # /analyze can still access the last processed frames

        return "Pipeline stopped"

    def stop(self):
        self.is_running = False