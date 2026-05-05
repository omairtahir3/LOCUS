from .detector import PillDetector
from .gesture import GestureDetector
from .keyframe import KeyframeExtractor, VideoSource
import asyncio
import httpx
import json
import os
import numpy as np
from datetime import datetime, timezone, timedelta


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

    def __init__(self, api_base_url="http://localhost:8000", expected_medicine_count=0, medication_ids=None, scheduled_time="", token="", user_id=""):
        self.detector  = PillDetector(model_path="ai/best_model.onnx")
        self.gesture   = GestureDetector()
        self.extractor = KeyframeExtractor(target_fps=3, buffer_seconds=5, user_id=user_id, save_locally=True)
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
        self.user_id = user_id

    def _log_detection_to_db(self, status, confidence, keyframe_id=None):
        """
        Write a medication detection log directly to MongoDB.
        Uses pymongo (synchronous) since the pipeline runs in a background thread.
        Bypasses the HTTP API to avoid authentication issues.
        """
        if not self.medication_ids or not self.scheduled_time:
            print(f"[Pipeline] [DB-Log] No medication_ids or scheduled_time set — skipping log")
            return

        try:
            from pymongo import MongoClient
            from bson import ObjectId

            client = MongoClient("mongodb://localhost:27017")
            db = client["locusDB"]

            sched_str = self.scheduled_time
            # Convert "HH:MM" to full UTC datetime
            if len(sched_str) <= 5:
                today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                sh, sm = map(int, sched_str.split(":"))
                local_dt = today.replace(hour=sh, minute=sm)
                local_offset = datetime.now() - datetime.utcnow()
                scheduled_dt = local_dt - local_offset
            else:
                scheduled_dt = datetime.fromisoformat(sched_str.replace("Z", "+00:00"))

            ts_now = datetime.utcnow()

            for med_id in self.medication_ids:
                try:
                    # Look up user_id from the medication document
                    med_doc = db.medications.find_one({"_id": ObjectId(med_id)})
                    if not med_doc:
                        print(f"[Pipeline] [DB-Log] Medication {med_id} not found in DB")
                        continue

                    user_id = med_doc["user_id"]

                    # Check for existing log to avoid duplicates
                    existing = db.medication_logs.find_one({
                        "medication_id": ObjectId(med_id),
                        "user_id": ObjectId(str(user_id)),
                        "scheduled_time": scheduled_dt,
                    })
                    if existing:
                        print(f"[Pipeline] [DB-Log] Log already exists for {med_id} at {sched_str}")
                        continue

                    log_doc = {
                        "user_id": ObjectId(str(user_id)),
                        "medication_id": ObjectId(med_id),
                        "scheduled_time": scheduled_dt,
                        "status": status,
                        "verification_method": "Camera",
                        "confidence_score": round(confidence, 3),
                        "keyframe_id": keyframe_id,
                        "taken_at": ts_now if status == "taken" else None,
                        "notes": f"AI detection (confidence: {confidence:.1%})",
                        "created_at": ts_now,
                        "updated_at": ts_now,
                    }
                    db.medication_logs.insert_one(log_doc)
                    print(f"[Pipeline] [DB-Log] ✓ {med_id} logged as {status.upper()} (conf={confidence:.2f})")
                except Exception as ex:
                    print(f"[Pipeline] [DB-Log] Error for {med_id}: {ex}")

            client.close()
        except Exception as e:
            print(f"[Pipeline] [DB-Log] Fatal error: {e}")

    def _log_detection_to_db_batch(self, status, confidence, pills_to_log, keyframe_id=None):
        """
        Log exactly `pills_to_log` medications as taken/verified.
        When multiple pills are taken at once (e.g., 2 pills in hand),
        this logs 2 medications. When only 1 pill is seen, only 1 med is logged.
        Remaining unlogged meds stay pending for another detection or get
        marked missed/skipped when the scheduler's 3-hour window expires.
        """
        if not self.medication_ids or not self.scheduled_time:
            print(f"[Pipeline] [DB-Log-Batch] No medication_ids or scheduled_time set — skipping")
            return

        try:
            from pymongo import MongoClient
            from bson import ObjectId

            client = MongoClient("mongodb://localhost:27017")
            db = client["locusDB"]

            sched_str = self.scheduled_time
            if len(sched_str) <= 5:
                today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                sh, sm = map(int, sched_str.split(":"))
                local_dt = today.replace(hour=sh, minute=sm)
                local_offset = datetime.now() - datetime.utcnow()
                scheduled_dt = local_dt - local_offset
                # Strip microseconds to match Node.js parsing!
                scheduled_dt = scheduled_dt.replace(microsecond=0)
            else:
                scheduled_dt = datetime.fromisoformat(sched_str.replace("Z", "+00:00")).replace(microsecond=0)

            ts_now = datetime.utcnow()
            logged_count = 0

            for med_id in self.medication_ids:
                if logged_count >= pills_to_log:
                    break  # Only log as many meds as pills detected

                try:
                    med_doc = db.medications.find_one({"_id": ObjectId(med_id)})
                    if not med_doc:
                        print(f"[Pipeline] [DB-Log-Batch] Medication {med_id} not found")
                        continue

                    user_id = med_doc["user_id"]

                    # Skip if already logged
                    existing = db.medication_logs.find_one({
                        "medication_id": ObjectId(med_id),
                        "user_id": ObjectId(str(user_id)),
                        "scheduled_time": scheduled_dt,
                    })
                    if existing:
                        print(f"[Pipeline] [DB-Log-Batch] Already logged {med_doc.get('name', med_id)}")
                        continue

                    log_doc = {
                        "user_id": ObjectId(str(user_id)),
                        "medication_id": ObjectId(med_id),
                        "scheduled_time": scheduled_dt,
                        "status": status,
                        "verification_method": "visual",
                        "confidence_score": round(confidence, 3),
                        "keyframe_id": keyframe_id,
                        "taken_at": ts_now if status == "taken" else None,
                        "notes": f"AI batch detection ({pills_to_log} pills seen, confidence: {confidence:.1%})",
                        "createdAt": ts_now,
                        "updatedAt": ts_now,
                    }
                    db.medication_logs.insert_one(log_doc)
                    logged_count += 1
                    print(f"[Pipeline] [DB-Log-Batch] ✓ {med_doc.get('name', med_id)} logged as {status.upper()} "
                          f"({logged_count}/{pills_to_log} pills, conf={confidence:.2f})")
                except Exception as ex:
                    print(f"[Pipeline] [DB-Log-Batch] Error for {med_id}: {ex}")

            if logged_count < pills_to_log:
                print(f"[Pipeline] [DB-Log-Batch] Only {logged_count}/{pills_to_log} meds logged "
                      f"(remaining meds may already be logged or not found)")

            client.close()
        except Exception as e:
            print(f"[Pipeline] [DB-Log-Batch] Fatal error: {e}")

    def _tag_detection_keyframes(self, result, confidence, status):
        """
        After a successful detection, tag ONLY the 3 best-evidence keyframes
        (one per phase) with medicine_taken=True and phase_role metadata.
        These tagged frames appear on the Keyframe Audit page and Memory Search.

        Phase 1 (pill visible): best pill-in-hand frame
        Phase 2 (grip/motion): best grip or upward-motion frame
        Phase 3 (pill gone):   best frame showing pill has disappeared
        """
        try:
            pd = result.get("phase_details", {})
            p1 = pd.get("phase1_medicine_visible", {})
            p2 = pd.get("phase2_grip_and_motion", {})
            p3 = pd.get("phase3_medicine_gone", {})

            # Collect the best keyframe ID per phase
            best_frames = {
                "phase1_pill_visible": p1.get("keyframe_id"),
                "phase2_grip_motion": p2.get("keyframe_id"),
                "phase3_pill_gone": p3.get("keyframe_id"),
            }

            # Look up medication names for tagging
            med_names = []
            if self.medication_ids:
                try:
                    from pymongo import MongoClient
                    from bson import ObjectId
                    client = MongoClient("mongodb://localhost:27017")
                    db = client["locusDB"]
                    for mid in self.medication_ids:
                        doc = db.medications.find_one({"_id": ObjectId(mid)})
                        if doc:
                            med_names.append(doc.get("name", "Unknown"))
                    client.close()
                except Exception:
                    pass

            med_name = ", ".join(med_names) if med_names else "Unknown"
            med_id = self.medication_ids[0] if self.medication_ids else ""

            tagged = 0
            for phase_role, kf_id in best_frames.items():
                if not kf_id:
                    continue
                if self.extractor.storage:
                    # Use enhanced tagging with medicine_taken and phase_role
                    meta_path = os.path.join(self.extractor.storage.storage_dir, f"{kf_id}.json")
                    if not os.path.exists(meta_path):
                        continue
                    try:
                        import json as _json
                        with open(meta_path, "r") as f:
                            meta = _json.load(f)
                        meta["medication_detected"] = True
                        meta["medicine_taken"] = True
                        meta["detection_confidence"] = round(confidence, 3)
                        meta["detection_status"] = status
                        meta["medication_name"] = med_name
                        meta["medication_id"] = med_id
                        meta["phase_role"] = phase_role
                        meta["phase_score"] = round(pd.get(phase_role.replace("phase1_pill_visible", "phase1_medicine_visible")
                                                          .replace("phase2_grip_motion", "phase2_grip_and_motion")
                                                          .replace("phase3_pill_gone", "phase3_medicine_gone"), {})
                                                    .get("score", 0.0), 3)
                        meta["detected_at"] = datetime.now(timezone.utc).isoformat()
                        with open(meta_path, "w") as f:
                            _json.dump(meta, f, indent=2)
                        tagged += 1
                        print(f"[Pipeline] Tagged {kf_id} as {phase_role} (medicine_taken=true)")
                    except Exception as e:
                        print(f"[Pipeline] Tag error for {kf_id}: {e}")

            print(f"[Pipeline] Tagged {tagged}/3 best-evidence keyframes (medicine_taken=true)")
        except Exception as e:
            print(f"[Pipeline] Keyframe tagging error: {e}")

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

          State 1 → Medicine visible (pass ≥ 0.60 AND pill-in-hand)
            Scan frames for pill detection. Lock the best pill score.
            Advance to State 2 once medicine is confirmed.

          State 2 → Grip / motion detected (pass ≥ 0.45)
            After medicine is found, scan for hand grip or upward motion.
            Lock the best gesture score.

          State 3 → Medicine gone (pass ≥ 0.50)
            After motion, compare early vs late frames.
            If pill visible early but gone late → medicine was taken.

        Final confidence = avg(weighted_sum, min_phase_score).
        The WEAKEST phase constrains the result — a single failed
        phase drags the entire confidence down. Per-phase minimums
        gate each verification tier:
          Auto-verify (≥0.85): every phase ≥ 0.50
          Needs confirmation (≥0.65): every phase ≥ 0.35

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

            if pill_in_hand and in_hand_count > best_in_hand_count:
                best_in_hand_count = in_hand_count

            if score > best_pill:
                best_pill = score
                best_pill_frame = i
                hand_with_pill = pill_in_hand

        phase1_score = best_pill
        # Phase 1 REQUIRES pill spatially overlapping a hand to pass.
        # This eliminates false positives from random objects on tables.
        phase1_pass = phase1_score >= 0.60 and hand_with_pill

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
        phase2_pass = phase2_score >= 0.45

        # ── Phase 3: Check if medicine is GONE ──────────────────────────
        # Instead of only looking after motion_frame (which may be the last
        # frame), compare EARLY vs LATE frames in the buffer.
        # If pills were visible in the first third but gone in the last third,
        # that's strong evidence the medicine was taken.
        phase3_score = 0.0
        pill_after_motion = 0.0
        hand_returned = False
        frames_after_motion = 0
        best_gone_frame = n - 1  # default to last frame

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
                # Pick the late frame with the lowest pill score as best evidence
                best_gone_score = 1.0
                for i in late_frames:
                    det = batch_detections[i]
                    ps = max((d["confidence"] for d in det["detections"]), default=0.0)
                    if ps < best_gone_score:
                        best_gone_score = ps
                        best_gone_frame = i
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
        # The weakest phase CONSTRAINS the overall confidence.
        # A weighted average alone lets strong phases mask failed ones
        # (e.g. P1=1.0, P2=1.0, P3=0.0 → 0.65 — wrongly passes confirm).
        # Now: confidence = avg(weighted_sum, min_phase), so a single
        # failed phase drags the entire score down.
        phases_passed = sum([phase1_pass, phase2_pass, phase3_pass])

        weighted_avg = (phase1_score * 0.35 + phase2_score * 0.30 + phase3_score * 0.35)
        min_phase = min(phase1_score, phase2_score, phase3_score)

        # Blend: 70% weighted average, 30% weakest phase.
        # This ensures strong overall evidence dominates while a single
        # failed phase still drags the score down meaningfully.
        # Example: P1=0.725, P2=1.0, P3=1.0 → 0.7*0.904 + 0.3*0.725 = 0.851 ✓
        # Example: P1=1.0,   P2=1.0, P3=0.0 → 0.7*0.650 + 0.3*0.000 = 0.455 ✗
        confidence = (weighted_avg * 0.70) + (min_phase * 0.30)

        # Hard gate: all 3 phases must individually pass their thresholds
        if phases_passed < 3:
            confidence = min(confidence, 0.60)
        if phases_passed < 2:
            confidence = min(confidence, 0.35)

        # Per-phase minimums for each verification tier:
        #   Auto-verify (≥0.85): every phase must score ≥ 0.50
        #   Needs confirmation (≥0.65): every phase must score ≥ 0.35
        if min_phase < 0.50:
            confidence = min(confidence, 0.84)   # block auto-verify
        if min_phase < 0.35:
            confidence = min(confidence, 0.64)   # block needs_confirmation

        print(f"  [Confidence] weighted_avg={weighted_avg:.3f} min_phase={min_phase:.3f} "
              f"→ blended={confidence:.3f} phases_passed={phases_passed}/3")

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
                "gone_frame": int(best_gone_frame),
            },
            "phases_passed": int(phases_passed),
            "min_phase_score": float(round(min_phase, 3)),
            "weighted_avg": float(round(weighted_avg, 3)),
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

        # Attach the best keyframe ID per phase from the frames analyzed
        p1 = phase_details.get("phase1_medicine_visible", {})
        p2 = phase_details.get("phase2_grip_and_motion", {})
        p3 = phase_details.get("phase3_medicine_gone", {})

        pf_idx = p1.get("pill_frame", -1)
        if 0 <= pf_idx < len(frames):
            p1["keyframe_id"] = frames[pf_idx]["id"]

        mf_idx = p2.get("motion_frame", -1)
        if 0 <= mf_idx < len(frames):
            p2["keyframe_id"] = frames[mf_idx]["id"]

        gf_idx = p3.get("gone_frame", -1)
        if 0 <= gf_idx < len(frames):
            p3["keyframe_id"] = frames[gf_idx]["id"]

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

        # ── Save keyframes based on confidence tier ─────────────────────
        # >= 85%  (auto_verified):      save + immediately log as taken
        # >= 65%  (needs_confirmation): save + log as needs_verification (user confirms)
        # <  65%:                        no save, no log
        if phase_details["phases_passed"] == 3 and confidence >= THRESHOLD_CONFIRM:
            try:
                import cv2, os, json as _json
                os.makedirs("keyframe_storage", exist_ok=True)
                label = "AUTO" if confidence >= THRESHOLD_AUTO_VERIFY else "MANUAL"
                for idx, (f_item, det, gest) in enumerate(zip(frames, batch_detections, batch_gestures)):
                    dbg = f_item["frame"].copy()
                    for d in det.get("detections", []):
                        b = d["bbox"]
                        x1, y1, x2, y2 = int(b["x1"]), int(b["y1"]), int(b["x2"]), int(b["y2"])
                        cv2.rectangle(dbg, (x1, y1), (x2, y2), (0, 255, 0), 2)
                        cv2.putText(dbg, f"pill {d['confidence']:.2f}", (x1, max(y1-8, 0)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
                    for hb in gest.get("hand_boxes", []):
                        x1, y1, x2, y2 = int(hb["x1"]), int(hb["y1"]), int(hb["x2"]), int(hb["y2"])
                        cv2.rectangle(dbg, (x1, y1), (x2, y2), (255, 0, 0), 2)
                    cv2.putText(dbg, f"Frame {idx:02d} | [{label}] conf:{confidence:.2f}", (8, 20),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
                    cv2.imwrite(f"keyframe_storage/verified_frame_{idx:02d}.jpg", dbg)
                with open("keyframe_storage/latest_analysis.json", "w") as jf:
                    _json.dump(result, jf, indent=4)
                print(f"[Pipeline] Saved {len(frames)} frames [{label}] + analysis JSON (conf={confidence:.2f})")
            except Exception as _e:
                print(f"[Pipeline] Frame save error: {_e}")

        if phase_details["phases_passed"] == 3 and confidence >= THRESHOLD_AUTO_VERIFY:
            # ── Batch pill detection: mark exactly as many meds as pills seen ──
            # If 2 pills seen in hand and 2 meds scheduled → both taken
            # If 1 pill seen in hand and 2 meds scheduled → only 1 taken now,
            #   the other stays pending for a second detection or gets missed at window end
            pills_counted = max(1, in_hand_count)
            # Cap at expected remaining so we don't over-count
            remaining = max(0, self.expected_medicine_count - self.medicines_taken_count)
            pills_to_log = min(pills_counted, remaining) if remaining > 0 else pills_counted

            event = {
                "timestamp": result["timestamp"],
                "pill_count": pills_to_log,
                "confidence": confidence,
                "classification": classification["classification"],
            }
            self.medicines_detected_this_session.append(event)
            self.medicines_taken_count += pills_to_log
            print(f"[Pipeline] Medicine auto-verified! Count: {self.medicines_taken_count} "
                  f"(+{pills_to_log} this detection, {in_hand_count} pills seen in hand)")

            # ── Real-time DB logging: log exactly pills_to_log medications ──
            # Instead of logging ALL medication_ids, only log the first N
            # where N = pills_to_log. This ensures that if 1 pill is seen,
            # only 1 med is marked taken; if 2 pills, both are marked taken.
            self._log_detection_to_db_batch(
                status="taken",
                confidence=confidence,
                pills_to_log=pills_to_log,
                keyframe_id=phase_details.get("phase1_medicine_visible", {}).get("keyframe_id"),
            )

            # ── Tag keyframes used in this detection ──
            self._tag_detection_keyframes(result, confidence, "taken")

        elif phase_details["phases_passed"] == 3 and confidence >= THRESHOLD_CONFIRM:
            # needs_confirmation tier — log ALL meds for user to manually verify
            self._log_detection_to_db(
                status="needs_verification",
                confidence=confidence,
                keyframe_id=phase_details.get("phase1_medicine_visible", {}).get("keyframe_id"),
            )

            # ── Tag keyframes used in this detection ──
            self._tag_detection_keyframes(result, confidence, "needs_verification")

        # Add counter to result
        result["medicines_taken_count"] = self.medicines_taken_count
        result["medicines_detected_this_session"] = self.medicines_detected_this_session
        result["expected_medicine_count"] = self.expected_medicine_count
        result["medicines_remaining"] = max(0, self.expected_medicine_count - self.medicines_taken_count)

        # Hands-free Auto-Shutdown: Stop immediately if goal is reached
        if self.expected_medicine_count > 0 and self.medicines_taken_count >= self.expected_medicine_count:
            print(f"[Pipeline] Goal reached! ({self.medicines_taken_count}/{self.expected_medicine_count}). Shutting down automatically.")
            self.stop()

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

        # Buffer management: If all 3 phases passed and confidence >= 65%, clear for next event
        if current_phases == 3 and result["final_confidence"] >= THRESHOLD_CONFIRM:
            with self.extractor._lock:
                self.extractor.buffer.clear()
            print(f"[Pipeline] Detection complete ({current_phases}/3 phases, conf={result['final_confidence']:.2f}) — buffer cleared for next dose")

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
        hands_detected = gesture["hands_detected"]
        
        if hands_detected == 0:
            # print(f"[QuickScan] Pill detected ({len(detections)}), but no hands found.")
            return False

        # Trigger if pill overlaps hand OR upward motion detected
        pill_in_hand, overlap, _ = self.is_pill_in_hand(detections, gesture)
        has_motion = gesture["upward_motion_score"] > 0.3

        # print(f"[QuickScan] Pill: {len(detections)} | Hands: {hands_detected} | "
        #       f"Pill-in-hand: {pill_in_hand} (overlap={overlap:.2f}) | Motion: {has_motion} (score={gesture['upward_motion_score']:.2f})")

        return pill_in_hand or has_motion

    def is_within_schedule_window(self, scheduled_times, window_minutes=180):
        """
        Check if current time is within ±window_minutes of any scheduled time.
        scheduled_times: list of "HH:MM" strings, e.g. ["08:00", "20:00"]
        Returns True if pipeline should be actively scanning.
        """
        if not scheduled_times:
            return True  # no schedule = always active

        # datetime and timedelta are imported at module level
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

        source=0 for webcam, or path to video file, or RTSP/RTMP URL.
        scheduled_times: list of "HH:MM" strings for when meds are expected.
        """
        print(f"Starting medication detection pipeline on source: {source}")
        if scheduled_times:
            print(f"Schedule-aware mode: active near {scheduled_times}")
        self.is_running = True

        try:
            import cv2
            import time

            # Use the threaded VideoSource for all sources — it handles
            # webcam, GoPro WiFi, RTSP/RTMP streams with proper buffer
            # draining to prevent latency buildup on live streams.
            cap = VideoSource(source)
            cap.open()

            frame_count = 0
            scan_every = 30        # quick scan every ~1 sec at 30fps
            pill_seen = False      # tracks if we've seen pill+hand
            last_full_analysis = 0 # frame count of last full analysis

            while self.is_running:
                ret, frame = cap.read()
                if not ret:
                    # Stream dropped — always reconnect regardless of frame count
                    self.camera_online = False
                    if frame_count == 0:
                        print(f"[Pipeline] ⚠ Could not read from {source}. Retrying in 5s...")
                    else:
                        print(f"[Pipeline] ⚠ Stream dropped after {frame_count} frames. Reconnecting in 5s...")
                    try:
                        cap.release()
                    except Exception:
                        pass
                    time.sleep(5)
                    try:
                        cap = VideoSource(source)
                        cap.open()
                    except Exception as e:
                        print(f"[Pipeline] Reconnect failed: {e}. Will retry...")
                    continue
                else:
                    self.camera_online = True

                frame_count += 1
                if frame_count % 30 == 0:
                    print(f"[Pipeline] Heartbeat: Receiving frames from {source}... (Total: {frame_count})")

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
                if pill_seen and not self._analyzing:
                    if last_full_analysis == 0 or (frame_count - last_full_analysis) >= 90:
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

                                    # Reset pill_seen after confirmed detection so pipeline
                                    # keeps watching for the next dose all day
                                    conf = result.get('final_confidence', 0)
                                    phases = result.get('phase_details', {}).get('phases_passed', 0)
                                    if phases == 3 and conf >= THRESHOLD_CONFIRM:
                                        pill_seen = False
                                        print('[Pipeline] Detection cycle complete (conf=' + f'{conf:.2f}' + ') - watching for next dose')
                            except Exception as e:
                                import traceback
                                print('[Pipeline Error] ' + traceback.format_exc())
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
                # If we already have a successful cached result, don't run analyze_buffer again!
                if not self.last_result:
                    result = self.analyze_buffer()
                    if result:
                        self.last_result = result
                else:
                    print("[Pipeline] Skipping redundant final analysis; using cached successful result.")
                    
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
                    if conf >= THRESHOLD_AUTO_VERIFY:
                        final_status = "taken"
                    elif conf >= THRESHOLD_CONFIRM:
                        final_status = "needs_verification"
                    else:
                        final_status = "missed"
                        
                    # CRITICAL FIX: Do not overwrite a successful session with 'missed'!
                    # If we already detected the expected medicines, the final status is success.
                    if self.expected_medicine_count > 0 and self.medicines_taken_count >= self.expected_medicine_count:
                        final_status = "taken"
                        
                    # CRITICAL FIX 2: Only post the FINAL status if it's NOT missed,
                    # OR if we haven't logged anything yet. (Since batch logging already posts in real-time)
                    if final_status == "missed" and self.medicines_taken_count > 0:
                        print(f"[Pipeline] Final status is missed, but we already took {self.medicines_taken_count} meds. Skipping duplicate 'missed' log.")
                        skip_final_log = True
                    else:
                        skip_final_log = False
                    # Downgrade to needs_verification to force manual clarification!
                    if final_status == "taken" and getattr(self, 'expected_medicine_count', 0) > 0:
                        taken_count = self.medicines_taken_count
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
                    if not skip_final_log:
                        # POST to backend for each identified medication at this time
                        import requests
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
                                    "confidence_score": conf,
                                    "keyframe_id": self.last_result.get("best_keyframe_id")
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
            if display:
                try:
                    cv2.destroyAllWindows()
                except Exception:
                    pass

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