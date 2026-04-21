from .detector import PillDetector
from .gesture import GestureDetector
from .keyframe import KeyframeExtractor, VideoSource
import asyncio
import httpx
import json
import numpy as np
from datetime import datetime, timezone


# Confidence thresholds — tuned for real-world YOLO + MediaPipe accuracy
THRESHOLD_AUTO_VERIFY   = 0.85   # auto log, no user confirmation needed
THRESHOLD_CONFIRM       = 0.65   # ask elderly user to manually confirm
THRESHOLD_MISSED        = 0.65   # below this, mark as missed


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

    def __init__(self, api_base_url="http://localhost:8000", expected_medicine_count=0, medication_ids=None, scheduled_time="", token=""):
        self.detector  = PillDetector(model_path="ai/best_model.onnx")
        self.gesture   = GestureDetector()
        self.extractor = KeyframeExtractor(target_fps=5, buffer_seconds=5)
        self.api_base  = api_base_url
        self.is_running = False
        self.last_result = None  # Store last analysis result

        # ── Medicine counter ──────────────────────────────────────────
        self.medicines_taken_count = 0
        self.medicines_detected_this_session = []  # list of detection events
        self.expected_medicine_count = expected_medicine_count  # how many meds scheduled
        self._analyzing = False  # prevents overlapping analysis runs
        self.medication_ids = medication_ids or []
        self.scheduled_time = scheduled_time
        self.token = token

    # ── Spatial Overlap: Pill-in-Hand Check ───────────────────────────

    @staticmethod
    def _bbox_overlap(box_a, box_b):
        """
        Compute the intersection area between two bounding boxes.
        Each box is a dict with keys x1, y1, x2, y2.
        Returns the overlap ratio relative to the smaller box.
        """
        x1 = max(box_a["x1"], box_b["x1"])
        y1 = max(box_a["y1"], box_b["y1"])
        x2 = min(box_a["x2"], box_b["x2"])
        y2 = min(box_a["y2"], box_b["y2"])

        if x2 <= x1 or y2 <= y1:
            return 0.0  # no overlap

        intersection = (x2 - x1) * (y2 - y1)
        area_a = max(1, (box_a["x2"] - box_a["x1"]) * (box_a["y2"] - box_a["y1"]))
        area_b = max(1, (box_b["x2"] - box_b["x1"]) * (box_b["y2"] - box_b["y1"]))
        smaller_area = min(area_a, area_b)

        return intersection / smaller_area

    def is_pill_in_hand(self, detections, gesture_result, overlap_threshold=0.1):
        """
        Check if any detected pill spatially overlaps with a detected hand.

        Args:
            detections: list of pill detections (each has 'bbox' with x1,y1,x2,y2)
            gesture_result: dict from GestureDetector.analyze_frame() with 'all_hand_bboxes'
            overlap_threshold: minimum overlap ratio to count as "in hand" (0.1 = 10%)

        Returns:
            (is_in_hand: bool, best_overlap: float, in_hand_count: int)
        """
        hand_bboxes = gesture_result.get("all_hand_bboxes", [])
        if not hand_bboxes or not detections:
            return False, 0.0, 0

        best_overlap = 0.0
        in_hand_count = 0

        for det in detections:
            pill_bbox = det["bbox"]
            for hand_bbox in hand_bboxes:
                overlap = self._bbox_overlap(pill_bbox, hand_bbox)
                if overlap > best_overlap:
                    best_overlap = overlap
                if overlap >= overlap_threshold:
                    in_hand_count += 1
                    break  # this pill counted, move to next

        return best_overlap >= overlap_threshold, round(best_overlap, 3), in_hand_count

    # ── Sequential State Machine Verification ────────────────────────

    def compute_temporal_confidence(self, batch_detections, batch_gestures):
        """
        Sequential state machine for medication intake verification.

        Processes frames one-by-one in temporal order, advancing through
        three states. Each phase locks its BEST score independently:

          State 1 → Medicine visible
            Scan frames for pill detection. Lock the best pill score.
            Advance to State 2 once medicine is confirmed (score ≥ 0.45).

          State 2 → Grip / motion detected
            After medicine is found, scan for hand grip or upward motion.
            Lock the best gesture score.
            Advance to State 3 once motion is confirmed (score ≥ 0.30).

          State 3 → Medicine gone (hand reappears empty)
            After motion, wait for a hand to reappear in frame.
            Check if the pill is still visible — if not, medicine was taken.
            Lock the best "medicine gone" evidence.

        Returns (confidence, phase_details) tuple.
        """
        n = len(batch_detections)

        # ── Phase 1: Best pill detection across all frames ─────────────
        # ONLY count a pill as "visible" when it spatially overlaps a hand.
        # Pills on a table (no hand overlap) get a heavily reduced score.
        best_pill = 0.0
        best_pill_frame = -1
        hand_with_pill = False
        best_in_hand_count = 0

        for i in range(n):
            det = batch_detections[i]
            gest = batch_gestures[i]
            pill_score = max((d["confidence"] for d in det["detections"]), default=0.0)
            has_hand = gest["hands_detected"] > 0
            num_pills = len(det["detections"])

            # Check spatial overlap between pill bboxes and hand bboxes
            pill_in_hand, overlap, in_hand_count = self.is_pill_in_hand(
                det["detections"], gest
            )

            if pill_in_hand:
                # Pill is IN a hand — full score + hand bonus
                score = min(1.0, pill_score + 0.1)
            elif has_hand and pill_score > 0:
                # Hand detected but pill not overlapping — reduced score
                score = pill_score * 0.3
            else:
                # No hand at all — pill on table, essentially ignored
                score = pill_score * 0.1

            # Debug: log per-frame details
            if pill_score > 0 or has_hand:
                print(f"  [Phase1] frame {i}/{n}: pills={num_pills} pill_score={pill_score:.2f} "
                      f"hand={has_hand} overlap={overlap:.2f} in_hand={pill_in_hand} "
                      f"in_hand_count={in_hand_count} -> score={score:.2f}")

            if score > best_pill:
                best_pill = score
                best_pill_frame = i
                hand_with_pill = pill_in_hand
                best_in_hand_count = in_hand_count

        phase1_score = best_pill
        phase1_pass = phase1_score >= 0.60

        # ── Phase 2: Best grip/motion AFTER medicine was first seen ────
        best_gesture = 0.0
        best_grip = 0.0
        best_motion = 0.0
        motion_frame = -1

        search_start = max(0, best_pill_frame)  # start from when pill was seen
        for i in range(search_start, n):
            gest = batch_gestures[i]
            grip = gest["grip_confidence"]
            motion = gest["upward_motion_score"]
            gesture = max(grip, motion)

            if grip > best_grip:
                best_grip = grip
            if motion > best_motion:
                best_motion = motion
            if gesture > best_gesture:
                best_gesture = gesture
                motion_frame = i

        phase2_score = min(1.0, best_gesture)
        phase2_pass = phase2_score >= 0.30

        # ── Phase 3: Check if medicine is GONE ──────────────────────────
        # Instead of only looking after motion_frame (which may be the last
        # frame), compare EARLY vs LATE frames in the buffer.
        # If pills were visible in the first third but gone in the last third,
        # that's strong evidence the medicine was taken.
        phase3_score = 0.0
        pill_after_motion = 0.0
        hand_returned = False
        frames_after_motion = 0

        # Strategy 1: Early-vs-Late comparison (more robust)
        # Early = first 1/3 (where pill should be visible)
        # Late = last 1/5 (very end — pill should be gone after intake)
        early_third = max(1, n // 3)
        late_fifth = max(1, n // 5)
        early_frames = range(0, early_third)
        late_frames = range(n - late_fifth, n)

        # Max pill confidence in early frames
        early_pill_max = 0.0
        for i in early_frames:
            det = batch_detections[i]
            pill_score = max((d["confidence"] for d in det["detections"]), default=0.0)
            early_pill_max = max(early_pill_max, pill_score)

        # Max pill confidence in late frames
        late_pill_max = 0.0
        for i in late_frames:
            det = batch_detections[i]
            pill_score = max((d["confidence"] for d in det["detections"]), default=0.0)
            late_pill_max = max(late_pill_max, pill_score)

        pill_drop = early_pill_max - late_pill_max

        # Strategy 2: Also check post-motion frames (original approach)
        post_motion_pill = 0.0
        if motion_frame >= 0:
            for i in range(motion_frame + 1, n):
                det = batch_detections[i]
                gest = batch_gestures[i]
                pill_score = max((d["confidence"] for d in det["detections"]), default=0.0)
                has_hand = gest["hands_detected"] > 0
                frames_after_motion += 1
                if has_hand:
                    hand_returned = True
                post_motion_pill = max(post_motion_pill, pill_score)

        # Use the BEST evidence from either strategy
        if early_pill_max >= 0.30:
            # We saw a pill early — check if it vanished
            if late_pill_max < 0.30:
                # Pill clearly gone in late frames → strong evidence
                phase3_score = min(1.0, pill_drop / early_pill_max) if early_pill_max > 0 else 0.0
                print(f"  [Phase3] Pill gone! early={early_pill_max:.2f} late={late_pill_max:.2f} drop={pill_drop:.2f}")
            elif post_motion_pill < 0.30 and frames_after_motion >= 2:
                # Late frames still have pill but post-motion frames don't
                phase3_score = min(1.0, (best_pill - post_motion_pill) / best_pill) if best_pill > 0 else 0.0
                print(f"  [Phase3] Pill gone post-motion: post_motion_pill={post_motion_pill:.2f}")
            else:
                # Pill still visible — NOT taken
                phase3_score = 0.0
                print(f"  [Phase3] Pill still visible: early={early_pill_max:.2f} late={late_pill_max:.2f}")
        elif motion_frame >= 0 and frames_after_motion > 0:
            # No pill detected early either — check post-motion
            if post_motion_pill < 0.30:
                phase3_score = 0.5  # partial credit
            else:
                phase3_score = 0.0
        else:
            # No pill detected at all and no motion — can't determine
            phase3_score = 0.0

        pill_after_motion = max(late_pill_max, post_motion_pill)
        phase3_pass = phase3_score >= 0.50

        # ── Final Confidence ──────────────────────────────────────────
        phases_passed = sum([phase1_pass, phase2_pass, phase3_pass])
        confidence = (phase1_score * 0.35 + phase2_score * 0.30 + phase3_score * 0.35)

        # All 3 phases must pass for auto-verification level confidence.
        if phases_passed < 3:
            confidence = min(confidence, 0.60)
        if phases_passed < 2:
            confidence = min(confidence, 0.35)

        phase_details = {
            "phase1_medicine_visible": {
                "score": float(round(phase1_score, 3)),
                "pass": bool(phase1_pass),
                "best_pill": float(round(best_pill, 3)),
                "pill_score": float(round(best_pill, 3)),
                "pill_frame": int(best_pill_frame),
                "pill_in_hand": bool(hand_with_pill),
                "in_hand_count": int(best_in_hand_count),
            },
            "phase2_grip_and_motion": {
                "score": float(round(phase2_score, 3)),
                "pass": bool(phase2_pass),
                "grip": float(round(best_grip, 3)),
                "motion": float(round(best_motion, 3)),
                "motion_frame": int(motion_frame),
            },
            "phase3_medicine_gone": {
                "score": float(round(phase3_score, 3)),
                "pass": bool(phase3_pass),
                "pill_after_motion": float(round(pill_after_motion, 3)),
                "pill_drop": float(round(max(0, best_pill - pill_after_motion), 3)),
                "hand_returned": bool(hand_returned),
                "frames_after": int(frames_after_motion),
            },
            "phases_passed": int(phases_passed),
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
                "classification": "missed",
                "action": "mark_missed",
                "message": "Confidence below threshold — marked as missed",
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

        # ── Medicine counter: track verified intakes ────────────────────
        # All 3 phases must pass for the counter to increment:
        # Phase 1 (pill in hand) + Phase 2 (grip/motion) + Phase 3 (pill gone)
        in_hand_count = phase_details.get("phase1_medicine_visible", {}).get("in_hand_count", 0)

        if phase_details["phases_passed"] == 3 and classification["classification"] in ("auto_verified", "needs_confirmation"):
            pills_counted = max(1, in_hand_count)

            event = {
                "timestamp": result["timestamp"],
                "pill_count": pills_counted,
                "confidence": confidence,
                "classification": classification["classification"],
            }
            self.medicines_detected_this_session.append(event)
            self.medicines_taken_count += pills_counted
            print(f"[Pipeline] Medicine taken! Count: {self.medicines_taken_count} "
                  f"(+{pills_counted} this detection, {in_hand_count} pills seen in hand)")

        # Add counter to result
        result["medicines_taken_count"] = self.medicines_taken_count
        result["medicines_detected_this_session"] = self.medicines_detected_this_session
        result["expected_medicine_count"] = self.expected_medicine_count
        result["medicines_remaining"] = max(0, self.expected_medicine_count - self.medicines_taken_count)

        # Smart result caching (Peak Evidence Locking):
        # We prioritize results that have more phases passed (temporal sequence completeness).
        # If phases are equal, we prioritize higher final confidence.
        current_phases = phase_details.get("phases_passed", 0)
        last_phases = self.last_result.get("phase_details", {}).get("phases_passed", 0) if self.last_result else -1

        should_update = False
        if not self.last_result:
            should_update = True
        elif current_phases > last_phases:
            should_update = True
        elif current_phases == last_phases and result["final_confidence"] >= self.last_result["final_confidence"]:
            should_update = True

        if should_update:
            self.last_result = result

        # Buffer management: If all 3 phases passed, clear for next event
        if current_phases == 3:
            with self.extractor._lock:
                self.extractor.buffer.clear()
            print(f"[Pipeline] Peak evidence locked ({current_phases}/3 phases) - buffer cleared for next detection cycle")

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

    def quick_scan(self, frame):
        """
        Lightweight single-frame check (~110ms).
        Returns True if a pill is detected AND either:
          - pill is near/in hand (spatial overlap), OR
          - upward motion is detected (hand moving to mouth)
        This triggers the heavy full-buffer analysis.
        """
        detections = self.detector.detect(frame)
        if not detections:
            return False

        # Pill found — check for hand or motion
        gesture = self.gesture.analyze_frame(frame)
        if gesture["hands_detected"] == 0:
            return False

        # Trigger if pill overlaps hand OR upward motion detected
        pill_in_hand, _, _ = self.is_pill_in_hand(detections, gesture)
        has_motion = gesture["upward_motion_score"] > 0.3

        return pill_in_hand or has_motion

    def is_within_schedule_window(self, scheduled_times, window_minutes=15):
        """
        Check if current time is within ±window_minutes of any scheduled time.
        scheduled_times: list of "HH:MM" strings, e.g. ["08:00", "20:00"]
        Returns True if pipeline should be actively scanning.
        """
        if not scheduled_times:
            return True  # no schedule = always active

        from datetime import datetime, timedelta
        now = datetime.now()
        current_minutes = now.hour * 60 + now.minute

        for t in scheduled_times:
            try:
                parts = t.split(":")
                sched_minutes = int(parts[0]) * 60 + int(parts[1])
                diff = abs(current_minutes - sched_minutes)
                # Handle midnight wrap
                diff = min(diff, 1440 - diff)
                if diff <= window_minutes:
                    return True
            except (ValueError, IndexError):
                continue

        return False

    def run_on_video(self, source=0, display=False, scheduled_times=None):
        """
        Run the full pipeline on a video source.

        Optimized flow:
        1. ALL frames go into buffer + disk storage (lightweight)
        2. Every 30 frames (~1 sec): run quick_scan() on a single frame
        3. Only if pill-in-hand detected: trigger full analyze_buffer()
        4. Time-aware: only scan during ±15 min of scheduled medication times

        source=0 for webcam, or path to video file.
        scheduled_times: list of "HH:MM" strings for when meds are expected.
        """
        print(f"Starting medication detection pipeline on source: {source}")
        if scheduled_times:
            print(f"Schedule-aware mode: active near {scheduled_times}")
        self.is_running = True

        try:
            import cv2
            import time
            cap = cv2.VideoCapture(source)
            if not cap.isOpened():
                raise RuntimeError(f"Cannot open video source: {source}")

            frame_count = 0
            scan_every = 30        # quick scan every ~1 sec at 30fps
            pill_seen = False      # tracks if we've seen pill+hand
            last_full_analysis = 0 # frame count of last full analysis

            while self.is_running:
                ret, frame = cap.read()
                if not ret:
                    print(f"End of video source (total frames: {frame_count})")
                    self.is_running = False

                    # Cleanup happens in the 'finally' block below
                    break

                frame_count += 1

                # Yield GIL so uvicorn can serve HTTP requests
                time.sleep(0.001)

                # Step 1: Always buffer every frame (lightweight)
                keyframe = self.extractor.process_frame(frame)

                # Step 2: Schedule check — skip scanning outside med windows
                if scheduled_times and not self.is_within_schedule_window(scheduled_times):
                    continue  # just buffer frames, don't scan

                # Step 3: Quick scan every ~1 sec (single frame, ~110ms)
                if frame_count % scan_every == 0:
                    if self.quick_scan(frame):
                        if not pill_seen:
                            print(f"[Trigger] Pill in hand detected at frame {frame_count} — starting full analysis")
                        pill_seen = True

                # Step 4: Full analysis only when pill was seen in hand
                # Run in background thread so frame reading doesn't freeze
                if pill_seen and (frame_count - last_full_analysis) >= 90 and not self._analyzing:
                    last_full_analysis = frame_count

                    def _run_analysis():
                        self._analyzing = True
                        try:
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

                                # Reset trigger if medicine was taken
                                if result['action'] != 'discard':
                                    pass # cannot reset local pill_seen from thread, handled next frame
                        finally:
                            self._analyzing = False

                    import threading
                    threading.Thread(target=_run_analysis, daemon=True).start()

                # Display annotated frame if debugging
                if display:
                    annotated = frame.copy()
                    h, w = frame.shape[:2]
                    status = "SCANNING" if pill_seen else "IDLE"
                    status_color = (0, 255, 0) if pill_seen else (150, 150, 150)
                    cv2.putText(annotated, f"[{status}] Frame: {frame_count}",
                                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, status_color, 2)
                    cv2.putText(annotated, f"Meds taken: {self.medicines_taken_count}",
                                (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 200, 255), 2)
                    cv2.imshow("LOCUS - Medication Detection", annotated)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break

        finally:
            self.is_running = False

            # Flush remaining keyframes to disk
            try:
                self.extractor.flush_remaining()
            except Exception as e:
                print(f"[Pipeline] Flush error: {e}")

            # ── FINAL ANALYSIS — always runs when pipeline stops ──────
            try:
                # Do not overwrite self.last_result with None if buffer is empty but we have a cached result!
                result = self.analyze_buffer()
                if result:
                    self.last_result = result
                    
                # If we have a result (either just analyzed or cached from earlier), POST the log
                if self.last_result and self.medication_ids and self.scheduled_time:
                    pd = self.last_result.get("phase_details", {})
                    
                    # Evaluation Logic
                    conf = self.last_result['final_confidence']
                    phases = pd.get('phases_passed', 0)
                    
                    # Threshold logic:
                    #   >= 0.85  -> taken (auto-verified)
                    #   >= 0.65  -> needs_verification (elderly user confirms)
                    #   <  0.65  -> missed
                    if conf >= 0.845:
                        final_status = "taken"
                    elif conf >= 0.65:
                        final_status = "needs_verification"
                    else:
                        final_status = "missed"
                        
                    # CRITICAL FIX: If the number of pills visually detected and swallowed
                    # is fewer than what was scheduled, we cannot assume all were taken.
                    # Downgrade to needs_verification to force manual clarification!
                    if final_status == "taken" and getattr(self, 'expected_medicine_count', 0) > 0:
                        taken_count = self.last_result.get('medicines_taken_count', 0)
                        if taken_count < self.expected_medicine_count:
                            print(f"[Pipeline] WARNING: Expected {self.expected_medicine_count} meds but only tracked {taken_count}. Downgrading to needs_verification.")
                            final_status = "needs_verification"
                        
                    print(f"\n{'='*60}")
                    print(f"FINAL ANALYSIS (Pipeline Stopped)")
                    print(f"{'='*60}")
                    print(f"Frames analyzed:  {self.last_result['frames_analyzed']}")
                    print(f"Confidence:       {self.last_result['final_confidence']:.2f}")
                    print(f"Classification:   {self.last_result['classification']}")
                    print(f"Phases passed:    {phases}/3")
                    print(f"Action:           {self.last_result['action']}")
                    print(f"Medicines taken:  {self.last_result.get('medicines_taken_count', 0)}")
                    print(f"Final Status:     {final_status}")
                    print(f"{'='*60}\n")
                    
                    # POST to backend for each identified medication at this time
                    import requests
                    from datetime import datetime
                    sched_str = self.scheduled_time
                    if len(sched_str) <= 5:  # e.g. "08:00"
                        local_dt = datetime.strptime(f"{datetime.now().strftime('%Y-%m-%d')} {sched_str}", "%Y-%m-%d %H:%M")
                        utc_dt = datetime.utcfromtimestamp(local_dt.timestamp())
                        sched_str = utc_dt.isoformat() + ".000Z"
                        
                    headers = {"Authorization": f"Bearer {self.token}"} if getattr(self, 'token', None) else {"x-internal": "true"}
                    
                    for med_id in self.medication_ids:
                        try:
                            payload = {
                                "medication_id": med_id,
                                "scheduled_time": sched_str,
                                "status": final_status,
                                "verification_method": "visual",
                                "confidence_score": conf
                            }
                            print(f"[{med_id}] Automatically pushing result to database: {final_status}")
                            
                            res = requests.post(f"{self.api_base}/api/medications/logs/", json=payload, headers=headers, timeout=5)
                            if res.status_code >= 400:
                                print(f"[{med_id}] [Error] Failed to post auto-log. HTTP {res.status_code}: {res.text}")
                            else:
                                print(f"[{med_id}] [Success] Auto-log posted. HTTP {res.status_code}")
                        except Exception as ex:
                            print(f"[{med_id}] Failed to post auto-log: {ex}")
                else:
                    print("[Pipeline] Final analysis: no frames in buffer to analyze and no cached result")
            except Exception as e:
                print(f"[Pipeline] Final analysis error: {e}")

            # Clean up resources
            cap.release()
            cv2.destroyAllWindows()
            self.gesture.close()

            # Check for skipped medicines and send notification
            self.check_for_skipped_medicines()

            # NOTE: buffer is intentionally NOT flushed here so
            # /analyze can still access the last processed frames

        return "Pipeline stopped"

    def check_for_skipped_medicines(self):
        """
        Compare medicines_taken_count vs expected_medicine_count.
        If user took fewer than expected, send a skip notification
        to the Node.js dashboard backend.
        """
        if self.expected_medicine_count <= 0:
            print("[Pipeline] No expected medicine count set — skipping skip-check.")
            return

        taken = self.medicines_taken_count
        expected = self.expected_medicine_count
        skipped = expected - taken

        print(f"[Pipeline] Skip check: taken={taken}, expected={expected}, skipped={skipped}")

        if skipped > 0:
            print(f"[Pipeline] [!] USER SKIPPED {skipped} MEDICINE(S)! Sending notification...")
            try:
                import requests
                payload = {
                    "scheduled_time": datetime.now(timezone.utc).isoformat(),
                    "expected_count": expected,
                    "taken_count": taken,
                    "skipped_count": skipped,
                    "detection_events": self.medicines_detected_this_session,
                }
                resp = requests.post(
                    f"{self.api_base}/api/notifications/skip",
                    json=payload,
                    timeout=5.0
                )
                if resp.status_code in (200, 201):
                    print(f"[Pipeline] Skip notification sent successfully.")
                else:
                    print(f"[Pipeline] Skip notification failed: {resp.status_code} {resp.text}")
            except Exception as e:
                print(f"[Pipeline] Failed to send skip notification: {e}")
        else:
            print(f"[Pipeline] ✓ All {expected} expected medicines taken. No skips.")

    def stop(self):
        self.is_running = False
        self.is_running = False