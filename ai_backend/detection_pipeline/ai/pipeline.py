from .detector import PillDetector
from .gesture import GestureDetector
from keyframe_backend.keyframe import KeyframeExtractor, VideoSource
import asyncio
import httpx
import json
import os
import threading
import time
import numpy as np
from datetime import datetime, timezone, timedelta

GPS_STALENESS_THRESHOLD_MINUTES = 30

# ── Shared MongoDB connection pool (thread-safe, reused across all pipeline instances) ──
_mongo_client = None
_mongo_db = None

def _get_mongo_db():
    """Get or create a shared MongoDB connection. MongoClient is thread-safe."""
    global _mongo_client, _mongo_db
    if _mongo_client is None:
        try:
            from pymongo import MongoClient
            from .core.config import MONGODB_URI, MONGODB_DB
            _mongo_client = MongoClient(MONGODB_URI, maxPoolSize=20)
            _mongo_db = _mongo_client[MONGODB_DB]
            print("[Pipeline] Shared MongoDB connection pool initialized")
        except Exception as e:
            print(f"[Pipeline] WARNING: MongoDB connection failed: {e}")
            return None
    return _mongo_db

# Confidence thresholds - tuned for real-world YOLO + MediaPipe accuracy
from .core.policy import ConfidencePolicy
from db_config import get_client, get_db_name
EVENT_CONFIDENCE_POLICY = ConfidencePolicy(auto_verify_threshold=0.85, confirmation_threshold=0.70)

# ── Capture timing (Core FE-1, FE-3) ────────────────────────────────────────
# CAPTURE_FPS is the ceiling; KeyframeExtractor.should_capture() reduces below
# it when nothing is moving, which is the "increasing during motion, reducing
# during inactivity" half of FE-1.
CAPTURE_FPS = float(os.environ.get("CAPTURE_FPS", 5.0))
# History held for batch analysis. BATCH_ANALYSIS_FRAMES is deliberately equal
# to BUFFER_SECONDS * CAPTURE_FPS: analyse exactly the window captured since
# the last pass, so no frame is skipped and none is examined twice.
BUFFER_SECONDS = float(os.environ.get("BUFFER_SECONDS", 30.0))
BATCH_ANALYSIS_FRAMES = int(BUFFER_SECONDS * CAPTURE_FPS)

# Per-frame activity events are retired in favour of Tier-2 environment
# sessions. Flip to True to restore the old behaviour for comparison.
EMIT_PER_FRAME_ACTIVITY_EVENTS = False
THRESHOLD_AUTO_VERIFY = EVENT_CONFIDENCE_POLICY.auto_verify_threshold

# Minimum pill confidence required IN THE PHASE-2 FRAME. Phase 2 judged hand
# position alone, so any hand raised toward the face scored >= 0.75 whether it
# held a pill, a pen, or nothing. Matches the 0.45 bar phase 1 already applies.
PHASE2_MIN_PILL_CONF = 0.45
THRESHOLD_CONFIRM = EVENT_CONFIDENCE_POLICY.confirmation_threshold
THRESHOLD_MISSED = EVENT_CONFIDENCE_POLICY.confirmation_threshold



class MedicationDetectionPipeline:
    """
    Core detection pipeline combining:
    - YOLOv8 object detection (tablets and capsules)
    - MediaPipe gesture detection (grip + upward hand motion)
    - Temporal sequence analysis (phases: pill visible -> hand grips -> pill disappears)
    - Confidence scoring and event classification

    Uses temporal phase analysis instead of side-by-side scoring:
    the buffer is split into early/mid/late phases and the pipeline
    looks for the medication-taking SEQUENCE where pills appearing
    early and disappearing late is a positive indicator.
    """

    def __init__(self, api_base_url="http://localhost:8000", expected_medicine_count=0, medication_ids=None, scheduled_time="", token="", user_id="", confidence_thresholds=None):
        import time
        t0 = time.time()
        print(f"[Profiling] Pipeline init start at {t0}")
        self.detector  = PillDetector(model_path="ai/best_model.onnx")
        self.gesture   = GestureDetector()
        # FE-1: 5 FPS ceiling. FE-3: the rolling buffer holds BUFFER_SECONDS of
        # history. It is sized to exactly the batch interval below (150 frames
        # = 30 s at 5 FPS) so every captured frame is analysed once, with no
        # gap and no rework. 5-10 s would be too short here: the three-phase
        # pill sequence (medicine visible -> grip -> medicine gone) routinely
        # spans longer than that, and a window shorter than the action defeats
        # the point of buffering at all. The 5-10 s figure in FE-3 is the
        # per-EVENT window, which core/engine.py implements as 3 s before plus
        # 3 s after the motion that triggered it.
        self.extractor = KeyframeExtractor(target_fps=CAPTURE_FPS, buffer_seconds=BUFFER_SECONDS,
                                               user_id=user_id, save_locally=True,
                                               window_duration=1.0, top_n_per_window=1)
        self.extractor.on_scene_saved = self._log_scene_to_db
        from .core.policy import ConfidencePolicy
        med_thresholds = (confidence_thresholds or {}).get("medication_intake", {})
        auto_v = med_thresholds.get("auto_verify", 0.85)
        conf = med_thresholds.get("confirm", 0.70)
        self.event_policy = ConfidencePolicy(auto_verify_threshold=auto_v, confirmation_threshold=conf)

        # FE-5: detectors come from the registry, not from fields hard-coded
        # here. Adding a detection type means writing a DetectorPlugin and
        # listing it in plugins/registry.py -- this file does not change, which
        # is what "without rebuilding the pipeline" has to mean in practice.
        # The named attributes below are kept because the medication, face and
        # activity paths still call their plugins directly; they are now views
        # onto the registry rather than the only place the plugins exist.
        from .plugins.registry import build_registry
        from .core.contracts import ActionType
        self.registry = build_registry()

        def _plugin(action_type):
            """None rather than a crash when a detector cannot be built.

            A missing optional dependency used to take the whole pipeline down
            at construction: no medication detection because insightface was
            not installed. Each batch runner already guards its own call, so a
            missing detector now costs only that detector.
            """
            try:
                return self.registry.get(action_type)
            except Exception as exc:
                print(f"[Pipeline] {action_type.value} detector unavailable: "
                      f"{type(exc).__name__}: {exc}")
                return None

        self.event_plugin = _plugin(ActionType.MEDICATION_INTAKE)
        self.face_plugin = _plugin(ActionType.SOCIAL_INTERACTION)
        self.activity_plugin = _plugin(ActionType.ACTIVITY)
        self.api_base  = api_base_url
        self.is_running = False
        self.last_result = None  # Store last analysis result

        # ── Medicine counter ──────────────────────────────────────────
        self.medicines_taken_count = 0
        self.medicines_detected_this_session = []  # list of detection events
        # Highest-confidence needs_verification already logged this session, or
        # None if there is none. The 'taken' branch is guarded by remaining<=0,
        # but needs_verification had no equivalent: every analysis pass that
        # found the same 3-phase sequence logged it again. One real intake was
        # analysed in two overlapping passes and wrote 5 evidence frames
        # (phase2+phase3 at 20:29:40, then phase1+phase2+phase3 at 20:31:15)
        # instead of the intended 3, one per phase.
        self.needs_verification_conf = None
        self.expected_medicine_count = expected_medicine_count  # how many meds scheduled
        self._analyzing = False  # prevents overlapping analysis runs
        self.medication_ids = medication_ids or []
        self.scheduled_time = scheduled_time
        self.token = token
        self.user_id = user_id

    def _attach_latest_location(self, db, doc, ts_now):
        try:
            from bson import ObjectId
            latest_loc = db.locationlogs.find_one(
                {"user_id": ObjectId(str(self.user_id))},
                sort=[("timestamp", -1)]
            )
            if latest_loc and "timestamp" in latest_loc and "lat" in latest_loc and "lng" in latest_loc:
                loc_ts = latest_loc["timestamp"]
                staleness = (ts_now - loc_ts).total_seconds() / 60.0
                if staleness <= GPS_STALENESS_THRESHOLD_MINUTES:
                    doc["location"] = {
                        "lat": latest_loc["lat"],
                        "lng": latest_loc["lng"]
                    }
                else:
                    print(f"[Pipeline] [DB-Log] Skipped GPS attach: Location stale by {staleness:.1f} mins (Threshold: {GPS_STALENESS_THRESHOLD_MINUTES})")
        except Exception as e:
            print(f"[Pipeline] [DB-Log] Error attaching location: {e}")

    def _log_scene_to_db(self, keyframe_id, motion_score):
        """
        Write a scene change activity log to MongoDB for Behavioral ML baseline.
        """
        if not self.user_id:
            return
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            client = get_client()
            db = client[get_db_name()]
            ts_now = datetime.utcnow()
            doc = {
                "user_id": ObjectId(str(self.user_id)),
                "event_type": "activity",
                "timestamp": ts_now,
                "confidence": 1.0,
                "details": {
                    "action": "scene_change",
                    "motion_score": motion_score,
                    "description": "Significant activity detected"
                },
                "keyframe_id": keyframe_id,
                "createdAt": ts_now,
                "updatedAt": ts_now
            }
            self._attach_latest_location(db, doc, ts_now)
            db.eventlogs.insert_one(doc)
            print(f"[Pipeline] [DB-Log] Logged scene_change activity event for {self.user_id}")

            # Tier-2 Asynchronous Daily Life Item Indexer (Passive indexing for Memory Search)
            try:
                from .item_indexer import DailyItemIndexer
                DailyItemIndexer.get_instance().enqueue_keyframe(
                    keyframe_id, None, {"user_id": str(self.user_id), "timestamp": ts_now.isoformat()}
                )
            except Exception as e:
                print(f"[Pipeline] [ItemIndexer Hook Note] {e}")
        except Exception as e:
            print(f"[Pipeline] [DB-Log] Error logging scene change: {e}")

    def _log_face_result_to_db(self, face_result):
        """
        Write a SOCIAL_INTERACTION or UNKNOWN_FACE event to the EventLog collection.
        """
        if not self.user_id:
            return
            
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            client = get_client()
            db = client[get_db_name()]
            ts_now = datetime.utcnow()
            
            # Confidence gating for upload. If >= 70%, we use the keyframe. 
            # Otherwise we don't store it for long term (or we still log the ID but the TTL cleans it).
            confidence = face_result.confidence
            kf_id = face_result.evidence_keyframe_ids[0] if face_result.evidence_keyframe_ids else None
            person_id = face_result.attributes.get("person_id")
            event_type = face_result.action_type.value
            
            # Ensure person_id is an ObjectId if present
            try:
                person_id_obj = ObjectId(str(person_id)) if person_id else None
            except:
                person_id_obj = None
            
            doc = {
                "user_id": ObjectId(str(self.user_id)),
                "event_type": event_type,
                "timestamp": ts_now,
                "confidence": confidence,
                "person_id": person_id_obj,
                "details": face_result.attributes,
                "keyframe_id": kf_id,
                "createdAt": ts_now,
                "updatedAt": ts_now
            }
            self._attach_latest_location(db, doc, ts_now)
            db.eventlogs.insert_one(doc)
            print(f"[Pipeline] [DB-Log] Logged face event: {event_type} for {self.user_id} with conf {confidence:.2f}")
        except Exception as e:
            import traceback
            print(f"[Pipeline] [DB-Log] Error logging face event: {e}")
            traceback.print_exc()

    def _log_activity_result_to_db(self, act_result):
        """
        Write an ACTIVITY event to the EventLog collection.
        """
        if not self.user_id:
            return
            
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            client = get_client()
            db = client[get_db_name()]
            
            # pipeline.py might import datetime, but let's be safe just in case
            from datetime import datetime
            ts_now = datetime.utcnow()
            
            confidence = act_result.confidence
            kf_id = act_result.evidence_keyframe_ids[0] if act_result.evidence_keyframe_ids else None
            event_type = act_result.action_type.value
            
            doc = {
                "user_id": ObjectId(str(self.user_id)),
                "event_type": event_type,
                "timestamp": ts_now,
                "confidence": confidence,
                "details": act_result.attributes,
                "keyframe_id": kf_id,
                "createdAt": ts_now,
                "updatedAt": ts_now
            }
            self._attach_latest_location(db, doc, ts_now)
            db.eventlogs.insert_one(doc)
            print(f"[Pipeline] [DB-Log] Logged activity event for {self.user_id}: {act_result.attributes.get('sentence', 'Unknown')}")
        except Exception as e:
            import traceback
            print(f"[Pipeline] [DB-Log] Error logging activity event: {e}")

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

            client = get_client()
            db = client[get_db_name()]

            sched_str = self.scheduled_time
            # Convert "HH:MM" to full UTC datetime
            if len(sched_str) <= 5:
                today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                sh, sm = map(int, sched_str.split(":"))
                local_dt = today.replace(hour=sh, minute=sm)
                scheduled_dt = local_dt.astimezone(timezone.utc).replace(tzinfo=None)
            else:
                scheduled_dt = datetime.fromisoformat(sched_str.replace("Z", "+00:00")).replace(tzinfo=None)

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
                    from datetime import timedelta
                    start_win = scheduled_dt - timedelta(minutes=30)
                    end_win = scheduled_dt + timedelta(minutes=30)
                    existing = db.medication_logs.find_one({
                        "medication_id": ObjectId(med_id),
                        "user_id": ObjectId(str(user_id)),
                        "scheduled_time": {"$gte": start_win, "$lte": end_win},
                    })
                    log_doc = {
                        "user_id": ObjectId(str(user_id)),
                        "medication_id": ObjectId(med_id),
                        "scheduled_time": scheduled_dt,
                        "status": status,
                        "verification_method": "Camera",
                        "confidence_score": round(confidence, 3),
                        "keyframe_id": keyframe_id,
                        "notes": f"AI detection (confidence: {confidence:.1%})",
                        "updated_at": ts_now,
                    }
                    if status == "taken":
                        log_doc["taken_at"] = ts_now

                    if existing:
                        db.medication_logs.update_one({"_id": existing["_id"]}, {"$set": log_doc})
                        print(f"[Pipeline] [DB-Log] Updated existing log for {med_id} at {sched_str} to {status.upper()}")
                    else:
                        log_doc["created_at"] = ts_now
                        db.medication_logs.insert_one(log_doc)
                        print(f"[Pipeline] [DB-Log] OK {med_id} logged as {status.upper()} (conf={confidence:.2f})")
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
        marked missed/skipped when the scheduler's 2-hour window expires.
        """
        if not self.medication_ids or not self.scheduled_time:
            print(f"[Pipeline] [DB-Log-Batch] No medication_ids or scheduled_time set — skipping")
            return

        try:
            import httpx
            headers = {
                "x-internal": "true"
            }
            if getattr(self, "token", None):
                headers["Authorization"] = f"Bearer {self.token}"

            logged_count = 0
            for med_id in self.medication_ids:
                if logged_count >= pills_to_log:
                    break

                payload = {
                    "medication_id": med_id,
                    "user_id": getattr(self, "user_id", ""),
                    "scheduled_time": self.scheduled_time,
                    "status": status,
                    "confidence_score": round(confidence, 3),
                    "keyframe_id": keyframe_id,
                    "verification_method": "visual",
                    "notes": f"AI batch detection ({pills_to_log} pills seen, confidence: {confidence:.1%})"
                }

                try:
                    # Hit the Node.js backend so it can trigger push notifications and websockets
                    resp = httpx.post("http://localhost:5000/api/medications/logs", json=payload, headers=headers, timeout=10.0)
                    if resp.status_code in (200, 201):
                        logged_count += 1
                        print(f"[Pipeline] [DB-Log-Batch] OK API Logged {med_id} as {status.upper()} ({logged_count}/{pills_to_log})")
                    else:
                        print(f"[Pipeline] [DB-Log-Batch] API error for {med_id}: {resp.status_code} {resp.text}")
                except Exception as ex:
                    print(f"[Pipeline] [DB-Log-Batch] API Request error for {med_id}: {ex}")

            if logged_count < pills_to_log:
                print(f"[Pipeline] [DB-Log-Batch] Only {logged_count}/{pills_to_log} meds logged "
                      f"(remaining meds may already be logged or not found)")
        except Exception as e:
            print(f"[Pipeline] [DB-Log-Batch] Fatal error: {e}")

    def _tag_detection_keyframes(self, result, confidence, status, frames=None):
        """
        After a successful detection, save the 3 best-evidence keyframes
        (one per phase) to the dedicated EvidenceStorage directory.
        These tagged frames appear on the Keyframe Audit page / Medicine Evidence.

        If a keyframe file doesn't exist on disk, this method force-saves it
        from the in-memory frames list.

        Phase 1 (pill visible): best pill-in-hand frame
        Phase 2 (grip/motion): best grip or upward-motion frame
        Phase 3 (pill gone):   best frame showing pill has disappeared
        """
        try:
            from ai_backend.keyframe_backend.keyframe import MedicationEvidenceStorage as EvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR as EVIDENCE_STORAGE_DIR
        except ImportError:
            try:
                import sys
                # pipeline.py is at ai_backend/detection_pipeline/ai/pipeline.py
                # Need to add LOCUS/ (3 levels up) so 'ai_backend.keyframe_backend' resolves
                locus_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
                if locus_root not in sys.path:
                    sys.path.insert(0, locus_root)
                from ai_backend.keyframe_backend.keyframe import MedicationEvidenceStorage as EvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR as EVIDENCE_STORAGE_DIR
            except ImportError as ie:
                print(f"[Pipeline] WARNING: Could not import EvidenceStorage: {ie}")
                # Fallback: construct path manually
                evidence_dir = os.path.join(
                    os.path.dirname(os.path.abspath(__file__)), "..", "..",
                    "keyframe_backend", "medications_storage"
                )
                os.makedirs(evidence_dir, exist_ok=True)
                EVIDENCE_STORAGE_DIR = evidence_dir
                EvidenceStorage = None

        try:
            pd = result.get("phase_details", {})

            # Look up medication names for tagging
            med_names = []
            if self.medication_ids:
                try:
                    from pymongo import MongoClient
                    from bson import ObjectId
                    client = get_client()
                    db = client[get_db_name()]
                    for mid in self.medication_ids:
                        doc = db.medications.find_one({"_id": ObjectId(mid)})
                        if doc:
                            med_names.append(doc.get("name", "Unknown"))
                    client.close()
                except Exception:
                    pass

            med_name = ", ".join(med_names) if med_names else "Unknown"
            med_id = self.medication_ids[0] if self.medication_ids else ""

            # --- Save to EvidenceStorage ---
            if EvidenceStorage is not None:
                if not hasattr(self, '_evidence_storage') or self._evidence_storage is None:
                    self._evidence_storage = EvidenceStorage(EVIDENCE_STORAGE_DIR)

                evidence_store = self._evidence_storage
            else:
                evidence_store = None

            # --- Iterate over the evidence_frames list (already has unique IDs
            # and correct phase_role assigned by analyze_keyframes_batch) ---
            tagged = 0
            for ev_frame in (frames or []):
                ev_id = ev_frame.get("id")
                phase_role = ev_frame.get("phase_role", "unknown")
                frame_data = ev_frame.get("frame")

                if not ev_id or frame_data is None:
                    print(f"[Pipeline] Skipping evidence {phase_role} — no ID or frame data")
                    continue

                # Phase score lookup
                phase_key = (phase_role
                             .replace("phase1_pill_visible", "phase1_medicine_visible")
                             .replace("phase2_grip_motion", "phase2_grip_and_motion")
                             .replace("phase3_pill_gone", "phase3_medicine_gone"))
                phase_score = round(pd.get(phase_key, {}).get("score", 0.0), 3)

                # Save to EvidenceStorage
                if evidence_store:
                    # Determine phase_order from role name
                    if "phase1" in phase_role:
                        phase_order = 1
                    elif "phase2" in phase_role:
                        phase_order = 2
                    elif "phase3" in phase_role:
                        phase_order = 3
                    else:
                        phase_order = 0

                    evidence_meta = {
                        "id": ev_id,
                        "phase_role": phase_role,
                        "phase_order": phase_order,
                        "frame_index": ev_frame.get("frame_index", -1),
                        "phase_score": phase_score,
                        "detection_confidence": round(confidence, 3),
                        "detection_status": status,
                        "medication_name": med_name,
                        "medication_id": med_id,
                        "medicine_taken": True,
                        "user_id": getattr(self, "user_id", ""),
                        "detected_at": datetime.now(timezone.utc).isoformat(),
                    }
                    evidence_store.save(ev_id, frame_data, evidence_meta)
                    tagged += 1
                    print(f"[Pipeline] Saved evidence {ev_id[:8]} as {phase_role} (order={phase_order}, conf={phase_score})")

            print(f"[Pipeline] Saved {tagged}/3 evidence frames for medicine detection")
        except Exception as e:
            print(f"[Pipeline] Evidence frame saving error: {e}")

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

    def is_pill_in_hand(self, detections, gesture_result, overlap_threshold=0.15):
        """
        Check if any detected pill spatially overlaps with a detected hand.
        
        A pill is considered "in hand" if:
        - The pill bbox overlaps the hand bbox (IoU >= 0.15)
        - The YOLO detection is confident (>= 0.40)
        - The pill is small relative to the hand (< 35%)
        - The pill center is near the palm center (within hand diagonal)
        - The pill is not a fingertip false positive
        """
        hand_bboxes = gesture_result.get("all_hand_bboxes", [])
        all_fingertips = gesture_result.get("all_fingertips", [])
        all_palm_centers = gesture_result.get("all_palm_centers", [])
        if not hand_bboxes or not detections:
            return False, 0.0, 0

        best_overlap = 0.0
        in_hand_count = 0
        FINGERTIP_RADIUS = 45  # pixels

        for det in detections:
            # Skip weak YOLO detections — these are often false positives
            if det["confidence"] < 0.40:
                continue

            pill_bbox = det["bbox"]
            pill_w = pill_bbox["x2"] - pill_bbox["x1"]
            pill_h = pill_bbox["y2"] - pill_bbox["y1"]
            pill_cx = (pill_bbox["x1"] + pill_bbox["x2"]) / 2
            pill_cy = (pill_bbox["y1"] + pill_bbox["y2"]) / 2

            for hand_idx, hand_bbox in enumerate(hand_bboxes):
                # Must have real bbox overlap
                overlap = self._bbox_overlap(pill_bbox, hand_bbox)
                if overlap < overlap_threshold:
                    continue

                # Size check: pill must be small relative to hand
                hand_w = hand_bbox["x2"] - hand_bbox["x1"]
                hand_h = hand_bbox["y2"] - hand_bbox["y1"]
                pill_area = max(1, pill_w * pill_h)
                hand_area = max(1, hand_w * hand_h)
                size_ratio = pill_area / hand_area

                if size_ratio > 0.35:
                    print(f"  [SizeCheck] Detection too large for pill "
                          f"(ratio={size_ratio:.2f}, max=0.35) — rejected")
                    continue

                # Aspect ratio check: pills are roughly round/square
                aspect = max(pill_w, pill_h) / max(1, min(pill_w, pill_h))
                if aspect > 3.5:
                    print(f"  [AspectCheck] Detection too elongated "
                          f"(aspect={aspect:.1f}, max=3.5) — rejected")
                    continue

                # Palm proximity: pill must be near palm center
                is_near_palm = True
                if hand_idx < len(all_palm_centers):
                    palm = all_palm_centers[hand_idx]
                    palm_dist = ((pill_cx - palm["x"])**2 + (pill_cy - palm["y"])**2)**0.5
                    hand_diag = (hand_w**2 + hand_h**2)**0.5
                    max_palm_dist = hand_diag * 0.8  # within 80% of hand diagonal
                    if palm_dist > max_palm_dist:
                        is_near_palm = False
                        print(f"  [PalmCheck] Too far from palm center "
                              f"(dist={palm_dist:.0f}px, max={max_palm_dist:.0f}px) — rejected")
                        continue

                # Fingertip false-positive rejection using MediaPipe landmarks
                is_at_fingertip = False
                if hand_idx < len(all_fingertips) and hand_idx < len(all_palm_centers):
                    tips = all_fingertips[hand_idx]
                    palm = all_palm_centers[hand_idx]
                    palm_dist = ((pill_cx - palm["x"])**2 + (pill_cy - palm["y"])**2)**0.5

                    min_tip_dist = float("inf")
                    nearest_tip = -1
                    for ti, tip in enumerate(tips):
                        d = ((pill_cx - tip["x"])**2 + (pill_cy - tip["y"])**2)**0.5
                        if d < min_tip_dist:
                            min_tip_dist = d
                            nearest_tip = ti

                    # Near fingertip AND far from palm = finger false positive
                    if min_tip_dist < FINGERTIP_RADIUS and palm_dist > min_tip_dist * 2:
                        is_at_fingertip = True
                        names = ["thumb", "index", "middle", "ring", "pinky"]
                        print(f"  [FingertipCheck] Near {names[nearest_tip]} tip "
                              f"(tip={min_tip_dist:.0f}px, palm={palm_dist:.0f}px) — false positive")

                effective = overlap * 0.1 if is_at_fingertip else overlap

                if effective > best_overlap:
                    best_overlap = effective
                if effective >= overlap_threshold:
                    in_hand_count += 1
                    print(f"  [PillInHand] OK Pill confirmed in hand "
                          f"(overlap={overlap:.2f}, size={size_ratio:.2f}, "
                          f"conf={det['confidence']:.2f}, palm_ok={is_near_palm})")
                    break

        return best_overlap >= overlap_threshold, round(best_overlap, 3), in_hand_count

    # ── Legacy Sequential Verification (unused — kept for reference) ──

    def compute_temporal_confidence(self, batch_detections, batch_gestures):
        """
        Legacy sequential verification (no longer used by main loop).
        Replaced by analyze_keyframes_batch() for batch processing.

        Processes frames one-by-one in temporal order, advancing through
        three states. Each phase locks its BEST score independently:

          State 1 -> Medicine visible (pass >= 0.60 AND pill-in-hand)
            Scan frames for pill detection. Lock the best pill score.
            Advance to State 2 once medicine is confirmed.

          State 2 -> Grip / motion detected (pass >= 0.45)
            After medicine is found, scan for hand grip or upward motion.
            Lock the best gesture score.

          State 3 -> Medicine gone (pass >= 0.50)
            After motion, compare early vs late frames.
            If pill visible early but gone late -> medicine was taken.

        Final confidence = avg(weighted_sum, min_phase_score).
        The WEAKEST phase constrains the result — a single failed
        phase drags the entire confidence down. Per-phase minimums
        gate each verification tier:
          Auto-verify (>=0.85): every phase >= 0.50
          Needs confirmation (>=0.65): every phase >= 0.35

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
        # Uses the pill frame from Phase 1 as the anchor point.
        # Compares pill confidence AT best_pill_frame vs AFTER it.
        # If pill was visible at pill_frame but gone in later frames,
        # that's strong evidence the medicine was taken.
        phase3_score = 0.0
        pill_drop = 0.0
        best_gone_frame = n - 1

        # The pill was best detected at best_pill_frame (from Phase 1)
        # Check pill presence in frames AFTER the pill was seen
        at_pill_score = best_pill  # confidence when pill was visible (Phase 1)

        # Check pill scores in the LAST portion of the buffer (after pill frame)
        # Use frames from pill_frame onward (at least last 1/3)
        check_start = max(best_pill_frame + 1, n - max(1, n // 3))
        late_pill_max = 0.0
        late_pill_scores = []
        for i in range(check_start, n):
            det = batch_detections[i]
            pill_score = max((d["confidence"] for d in det["detections"]), default=0.0)
            late_pill_scores.append(pill_score)
            late_pill_max = max(late_pill_max, pill_score)

        # Also check post-motion frames (original Strategy 2)
        post_motion_pill = 0.0
        hand_returned = False
        frames_after_motion = 0
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

        pill_drop = at_pill_score - late_pill_max

        # Score Phase 3 using the best evidence available
        if at_pill_score >= 0.30:
            # We know the pill was visible (Phase 1 confirmed it)
            if late_pill_max < 0.30:
                # Pill clearly gone in later frames -> strong evidence
                phase3_score = min(1.0, pill_drop / at_pill_score) if at_pill_score > 0 else 0.0
                # Find the best "gone" frame
                best_gone_score = 1.0
                for i in range(check_start, n):
                    det = batch_detections[i]
                    ps = max((d["confidence"] for d in det["detections"]), default=0.0)
                    if ps < best_gone_score:
                        best_gone_score = ps
                        best_gone_frame = i
                print(f"  [Phase3] Pill gone! at_pill={at_pill_score:.2f} late={late_pill_max:.2f} drop={pill_drop:.2f}")
            elif post_motion_pill < 0.30 and frames_after_motion >= 2:
                # Late frames still detect something but post-motion frames don't
                phase3_score = min(1.0, (at_pill_score - post_motion_pill) / at_pill_score) if at_pill_score > 0 else 0.0
                print(f"  [Phase3] Pill gone post-motion: post_motion_pill={post_motion_pill:.2f}")
            elif late_pill_max < at_pill_score * 0.5:
                # Pill confidence dropped significantly (>50%) even if still faintly detected
                phase3_score = min(0.7, pill_drop / at_pill_score) if at_pill_score > 0 else 0.0
                print(f"  [Phase3] Pill fading: at_pill={at_pill_score:.2f} late={late_pill_max:.2f}")
            else:
                # Pill still clearly visible -> NOT taken
                phase3_score = 0.0
                print(f"  [Phase3] Pill still visible: at_pill={at_pill_score:.2f} late={late_pill_max:.2f}")
        elif motion_frame >= 0 and frames_after_motion > 0:
            # No strong pill detection at pill_frame but motion was detected
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
        # (e.g. P1=1.0, P2=1.0, P3=0.0 -> 0.65 — wrongly passes confirm).
        # Now: confidence = avg(weighted_sum, min_phase), so a single
        # failed phase drags the entire score down.
        phases_passed = sum([phase1_pass, phase2_pass, phase3_pass])

        weighted_avg = (phase1_score * 0.35 + phase2_score * 0.30 + phase3_score * 0.35)
        min_phase = min(phase1_score, phase2_score, phase3_score)

        # Blend: 70% weighted average, 30% weakest phase.
        # This ensures strong overall evidence dominates while a single
        # failed phase still drags the score down meaningfully.
        # Example: P1=0.725, P2=1.0, P3=1.0 -> 0.7*0.904 + 0.3*0.725 = 0.851 OK
        # Example: P1=1.0,   P2=1.0, P3=0.0 -> 0.7*0.650 + 0.3*0.000 = 0.455 ✗
        confidence = (weighted_avg * 0.70) + (min_phase * 0.30)

        # Hard gate: all 3 phases must individually pass their thresholds
        if phases_passed < 3:
            confidence = min(confidence, 0.60)
        if phases_passed < 2:
            confidence = min(confidence, 0.35)

        # Per-phase minimums for each verification tier:
        #   Auto-verify (>=0.85): every phase must score >= 0.50
        #   Needs confirmation (>=0.65): every phase must score >= 0.35
        if min_phase < 0.50:
            confidence = min(confidence, 0.84)   # block auto-verify
        if min_phase < 0.35:
            confidence = min(confidence, 0.64)   # block needs_confirmation

        print(f"  [Confidence] weighted_avg={weighted_avg:.3f} min_phase={min_phase:.3f} "
              f"-> blended={confidence:.3f} phases_passed={phases_passed}/3")

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
        return self.event_policy.legacy_classification(confidence)

    def _attach_event_record(self, result, evidence_frames=None):
        from .core.contracts import EventContext, EventRecord
        context = EventContext(
            user_id=self.user_id,
            timestamp=result.get("timestamp", ""),
            medication_ids=list(self.medication_ids),
        )
        detection = self.event_plugin.from_pipeline_result(result, context, evidence_frames)
        status = self.event_policy.status_for(detection.confidence)
        result["event"] = EventRecord.from_detection(detection, context, status).to_dict()
        return result

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
        # IMPORTANT: ensure each phase gets a UNIQUE frame so Phase 3 doesn't
        # overwrite Phase 1's evidence frame during tagging.
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
        # Ensure gone_frame is different from pill_frame
        # If they're the same, use the very last frame instead
        if gf_idx == pf_idx and len(frames) > 1:
            gf_idx = len(frames) - 1
            # If that's also pill_frame, try second-to-last
            if gf_idx == pf_idx and len(frames) > 2:
                gf_idx = len(frames) - 2
        if 0 <= gf_idx < len(frames):
            p3["keyframe_id"] = frames[gf_idx]["id"]

        print(f"  [Keyframes] P1=frame[{pf_idx}] P2=frame[{mf_idx}] P3=frame[{gf_idx}]")

        # Classify the event
        classification = self.classify_event(confidence)

        # Collect frame quality stats from the buffer
        buffer = self.extractor.get_buffer()
        blur_scores = [kf.get("blur_score", 0) for kf in buffer]
        avg_blur = float(np.mean(blur_scores)) if blur_scores else 0.0

        result = {
            "action_type": "medication_intake",
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
        self._attach_event_record(result)

        # ── Medicine counter: track verified intakes ────────────────────
        # All 3 phases must pass for the counter to increment:
        # Phase 1 (pill in hand) + Phase 2 (grip/motion) + Phase 3 (pill gone)
        in_hand_count = phase_details.get("phase1_medicine_visible", {}).get("in_hand_count", 0)

        # ===============================================================
        # NOTE: All tagging and DB logging is now handled EXCLUSIVELY
        # by the batch analysis in run_on_video().
        # analyze_buffer() is only used for:
        #   1. Status API responses (last_result cache)
        #   2. Final analysis summary at shutdown (informational only)
        # It does NOT tag keyframes or log medications as taken.
        # ===============================================================

        # Add counter to result (for status API)
        result["medicines_taken_count"] = self.medicines_taken_count
        result["medicines_detected_this_session"] = self.medicines_detected_this_session
        result["expected_medicine_count"] = self.expected_medicine_count
        result["medicines_remaining"] = max(0, self.expected_medicine_count - self.medicines_taken_count)

        # Cache result for status API
        current_phases = phase_details.get("phases_passed", 0)
        last_phases = self.last_result.get("phase_details", {}).get("phases_passed", 0) if self.last_result else -1
        if not self.last_result or current_phases > last_phases or \
           (current_phases == last_phases and result["final_confidence"] >= self.last_result.get("final_confidence", 0)):
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
            "status": "needs_verification" if result["action"] == "log_automatically" else "scheduled",
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
          - hand is detected with pill (relaxed: just both present)
        This triggers the heavy full-buffer analysis.
        """
        detections = self.detector.detect(frame)
        if not detections:
            return False

        # Pill found — check for hand or motion
        gesture = self.gesture.analyze_frame(frame)
        hands_detected = gesture["hands_detected"]
        
        if hands_detected == 0:
            print(f"[QuickScan] Pill detected ({len(detections)} pills, best={max(d['confidence'] for d in detections):.2f}), but no hands found.")
            return False

        # Trigger if pill overlaps hand IN PALM AREA or upward motion detected
        pill_in_hand, overlap, _ = self.is_pill_in_hand(detections, gesture)
        has_motion = gesture["upward_motion_score"] > 0.3

        print(f"[QuickScan] Pill: {len(detections)} | Hands: {hands_detected} | "
              f"Pill-in-palm: {pill_in_hand} (overlap={overlap:.2f}) | Motion: {has_motion} "
              f"(score={gesture['upward_motion_score']:.2f}) | Trigger: {pill_in_hand or has_motion}")

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

    def analyze_keyframes_batch(self):
        """
        Strict sequential 3-phase medication intake detection.
        
        Phase 1 GATES everything — if no pill-in-hand is found, Phase 2
        and Phase 3 are never attempted. This prevents false evidence from
        random frames when no medicine is actually visible.
        
        Phases are checked in strict temporal order — each phase ONLY
        examines frames that come AFTER the previous phase's frame:
        
          Phase 1: Pill is near/in palm area (YOLO pill + MediaPipe hand overlap)
                   → picks the frame with HIGHEST pill-in-hand confidence
          Phase 2: Hand moves upward toward mouth (frames AFTER P1 only)
                   → picks the frame with BEST motion evidence (highest score)
          Phase 3: Hand comes back into view with NO pill (frames AFTER P2 only)
                   → picks the frame with BEST empty-hand evidence
        
        Chronological ordering is enforced: P1 < P2 < P3 timestamps.
        
        Returns list of result dicts. Empty list if no sequences found.
        """
        import cv2

        # ── Schedule gate: only analyze when medication is active ─────
        if not self.medication_ids or not self.scheduled_time:
            print(f"[BatchAnalysis] No medication scheduled — skipping analysis")
            return []

        buffer = self.extractor.get_buffer()
        print(f"[BatchAnalysis] Buffer has {len(buffer)} frames")
        if len(buffer) < 3:
            print(f"[BatchAnalysis] Not enough frames in buffer ({len(buffer)} < 3), skipping")
            return []
        
        # Check what keys the buffer frames have
        sample_keys = list(buffer[0].keys()) if buffer else []
        print(f"[BatchAnalysis] Frame keys: {sample_keys}")
        has_raw = sum(1 for b in buffer if b.get('raw_frame') is not None)
        print(f"[BatchAnalysis] Frames with raw_frame: {has_raw}/{len(buffer)}")

        # At 5 FPS, the buffer can hold up to 300 frames (60 seconds).
        # Analyzing all 300 with YOLO + MediaPipe would be too slow.
        # Sample up to 60 evenly-spaced frames (~1 per second of buffer time).
        max_analyze = 60
        if len(buffer) > max_analyze:
            step = len(buffer) / max_analyze
            indices = [int(i * step) for i in range(max_analyze)]
            frames = [buffer[i] for i in indices]
        else:
            frames = list(buffer)

        # Run YOLO batch (single ONNX call for all 8 frames) + MediaPipe per frame
        import time as _time
        t_start = _time.time()

        # Prepare frame data for batch YOLO
        valid_frames = []
        for kf in frames:
            raw = kf.get("raw_frame")
            if raw is not None:
                valid_frames.append({"frame": raw, "timestamp": kf.get("timestamp", ""), "id": kf.get("id", ""), "kf": kf})

        if len(valid_frames) < 3:
            print(f"[BatchAnalysis] Not enough valid frames ({len(valid_frames)} < 3)")
            return []

        # Single ONNX batch call for all frames (~5s instead of ~38s)
        t0 = _time.time()
        batch_results = self.detector.detect_batch(valid_frames)
        t1 = _time.time()
        print(f"[BatchAnalysis] YOLO batch: {len(valid_frames)} frames in {t1-t0:.1f}s")

        # Now run MediaPipe on each frame + combine with YOLO results
        analyzed = []
        for fi, (vf, det_result) in enumerate(zip(valid_frames, batch_results)):
            raw = vf["frame"]
            detections = det_result["detections"]
            try:
                t_mp0 = _time.time()
                gesture = self.gesture.analyze_frame(raw)
                t_mp1 = _time.time()
                hands = gesture["hands_detected"]
                best_pill = max((d["confidence"] for d in detections), default=0.0)
                pih = False
                overlap = 0.0
                in_hand_count = 0
                if detections and hands > 0:
                    pih, overlap, in_hand_count = self.is_pill_in_hand(detections, gesture)

                hand_y = 1.0
                hbox = gesture.get("hand_bbox")
                if hbox:
                    hand_y = ((hbox["y1"] + hbox["y2"]) / 2.0) / raw.shape[0]

                motion = gesture.get("upward_motion_score", 0)
                near_top = gesture.get("hand_near_top", False)
                near_top_score = gesture.get("hand_near_top_score", 0)

                print(f"  [F{fi}] pill={best_pill:.2f} dets={len(detections)} in_hand={pih} "
                      f"hands={hands} hand_y={hand_y:.2f} motion={motion:.2f} "
                      f"near_top={near_top} mp={t_mp1-t_mp0:.2f}s")

                analyzed.append({
                    "kf": vf["kf"], "frame": raw, "detections": detections,
                    "gesture": gesture, "best_pill": best_pill,
                    "pill_in_hand": pih, "overlap": overlap,
                    "in_hand_count": in_hand_count, "hands": hands,
                    "hand_y": hand_y, "motion": motion,
                    "near_top": near_top, "near_top_score": near_top_score,
                    "timestamp": vf.get("timestamp", ""),
                })
            except Exception as e:
                print(f"[BatchAnalysis] Frame {fi} error: {e}")
                continue

        t_total = _time.time() - t_start
        print(f"[BatchAnalysis] Total inference: {len(analyzed)} frames in {t_total:.1f}s")

        if len(analyzed) < 3:
            print(f"[BatchAnalysis] Not enough analyzed frames ({len(analyzed)} < 3), skipping")
            return []

        print(f"[BatchAnalysis] Analyzing {len(analyzed)} frames from buffer of {len(buffer)}...")

        # Diagnostic: print what each frame sees
        for i, a in enumerate(analyzed):
            print(f"  [F{i}] pill={a['best_pill']:.2f} in_hand={a['pill_in_hand']} "
                  f"hands={a['hands']} hand_y={a['hand_y']:.2f} motion={a['motion']:.2f} "
                  f"near_top={a['near_top']} pills_count={a['in_hand_count']}")

        # ── PHASE 1 GATE: scan ALL frames for a pill ───────────
        # If no frame in the entire buffer has a pill detected,
        # there is no medication event happening — abort immediately.
        # We NO LONGER strictly require MediaPipe to detect a hand here,
        # because MediaPipe often fails on compressed RTSP streams.
        # We will let the Gemini VLM verify if the pill is actually in a hand.
        any_pill = any(
            a["best_pill"] >= 0.45
            for a in analyzed
        )
        if not any_pill:
            print(f"[BatchAnalysis] PHASE 1 GATE: No pill detected in any frame — aborting")
            return []

        # ── Strict Sequential 3-Phase Detection ──────────────────────
        results = []
        search_start = 0

        while search_start < len(analyzed) - 2:
            # ── PHASE 1: Pill in hand — BEST evidence frame ──────────
            # Requires BOTH: YOLO detects pill AND MediaPipe confirms
            # the pill bbox spatially overlaps the hand's palm area.
            # Pick the frame with HIGHEST pill confidence for best evidence.
            p1_idx = None
            p1_data = None
            best_p1_pill = -1.0
            # Search up to ~70% of remaining buffer to leave room for P2/P3
            remaining = len(analyzed) - search_start
            p1_search_end = min(len(analyzed), search_start + max(3, int(remaining * 0.7)))
            for i in range(search_start, p1_search_end):
                a = analyzed[i]
                if a["pill_in_hand"] and a["best_pill"] >= 0.45 and a["hands"] > 0:
                    if a["best_pill"] > best_p1_pill:
                        best_p1_pill = a["best_pill"]
                        p1_idx = i
                        p1_data = a

            if p1_data is None:
                print(f"[BatchAnalysis] No Phase 1 (pill in hand) from frame {search_start}")
                break

            print(f"  [Phase1] OK Best pill-in-hand at frame {p1_idx} "
                  f"(pill={p1_data['best_pill']:.2f}, count={p1_data['in_hand_count']})")

            # ── PHASE 2: Hand moves toward mouth (ONLY frames AFTER P1) ──
            # Pick the BEST motion frame, not just the first match.
            # Score each candidate by: how high the hand is + motion score + near-top.
            # The best frame is the one that most clearly shows the hand-to-mouth action.
            p2_idx = None
            p2_data = None
            best_p2_composite = -1.0
            consecutive_no_hand = 0
            hand_disappeared_start = None
            p2_disappeared = False  # track if P2 is via hand-disappearance fallback

            for i in range(p1_idx + 1, len(analyzed)):
                a = analyzed[i]

                if a["hands"] > 0:
                    consecutive_no_hand = 0  # reset
                    # Check if hand is moving UPWARD (hand_y decreasing)
                    prev_y = analyzed[i - 1]["hand_y"] if i > 0 else p1_data["hand_y"]
                    moving_up = (prev_y - a["hand_y"]) > 0.01
                    hand_risen_from_p1 = (p1_data["hand_y"] - a["hand_y"]) > 0.03
                    face_region = a["near_top"] or a["hand_y"] < 0.45

                    # Must satisfy motion criteria to be a candidate
                    is_valid = (
                        (moving_up and face_region)
                        or (hand_risen_from_p1 and face_region)
                        or a["hand_y"] < 0.30
                    )
                    if is_valid:
                        # Composite score: lower hand_y = higher score, plus motion bonus
                        height_score = max(0, 1.0 - a["hand_y"])  # 0-1, higher = hand higher up
                        motion_bonus = a["motion"] * 0.3
                        near_top_bonus = a["near_top_score"] * 0.2
                        composite = height_score * 0.5 + motion_bonus + near_top_bonus
                        if composite > best_p2_composite:
                            best_p2_composite = composite
                            p2_idx = i
                            p2_data = a
                else:
                    consecutive_no_hand += 1
                    if consecutive_no_hand == 1:
                        hand_disappeared_start = i
                    # Fallback: hand disappeared for 3+ consecutive frames AND
                    # pill confidence dropped — only if no better hand-visible candidate
                    if consecutive_no_hand >= 3 and p2_data is None:
                        if a["best_pill"] < p1_data["best_pill"] - 0.10:
                            p2_idx = hand_disappeared_start
                            p2_data = analyzed[hand_disappeared_start]
                            p2_disappeared = True
                            break

            if p2_data is None:
                print(f"[BatchAnalysis] No Phase 2 (hand toward mouth) after P1 at frame {p1_idx}")
                search_start = p1_idx + 1
                continue

            # Compute Phase 2 score
            if p2_data["hands"] > 0 and not p2_disappeared:
                p2_score = max(p2_data["motion"], p2_data.get("near_top_score", 0))
                # Height bonuses, not floors. These were `max(p2_score, X)`,
                # which meant any visible hand scored >= 0.75 regardless of
                # motion — a hand near the face scored the same whether it
                # held a pill, a pen, or nothing at all.
                if p2_data["hand_y"] < 0.25:
                    p2_score += 0.25
                elif p2_data["hand_y"] < 0.35:
                    p2_score += 0.20
                elif p2_data["hand_y"] < 0.45:
                    p2_score += 0.15
                elif p2_data["hand_y"] < 0.55:
                    p2_score += 0.10
                p2_score = min(1.0, p2_score)

                # Phase 2 previously ignored the pill signal entirely, judging
                # only hand position. The ONNX model already scores the pill in
                # this frame, so require it to still be present during the
                # hand-to-mouth motion rather than trusting the gesture alone.
                p2_pill = p2_data.get("best_pill", 0.0)
                if p2_pill < PHASE2_MIN_PILL_CONF:
                    print(f"  [Phase2] REJECTED at frame {p2_idx}: pill not present "
                          f"during motion (best_pill={p2_pill:.3f} < {PHASE2_MIN_PILL_CONF})")
                    search_start = p1_idx + 1
                    continue
                print(f"  [Phase2] OK Best hand-toward-mouth at frame {p2_idx} "
                      f"(hand_y={p2_data['hand_y']:.2f}, motion={p2_data['motion']:.2f}, "
                      f"composite={best_p2_composite:.2f}, score={p2_score:.2f})")
            else:
                # Hand disappeared for 3+ frames = body cam evidence.
                # Lowered from a flat 0.80: a hand simply leaving frame is weak
                # evidence (it happens reaching for anything off-camera), and
                # at 0.80 it contributed as much as a clearly observed motion.
                p2_score = 0.60
                print(f"  [Phase2] OK Hand disappeared for {consecutive_no_hand} frames at {p2_idx}")

            # ── PHASE 3: Hand comes back EMPTY (ONLY frames AFTER P2) ──
            # Pick the BEST empty-hand frame: hand visible, no pill, lowest pill confidence.
            # Also factor in hand visibility (more hands detected = better evidence).
            p3_idx = None
            p3_data = None
            best_p3_score = -1.0

            for i in range(p2_idx + 1, len(analyzed)):
                a = analyzed[i]
                # Skip if pill is still clearly in hand
                if a["pill_in_hand"]:
                    continue

                # REQUIRE: hand must be visible AND palm must be empty
                if a["hands"] > 0 and not a["pill_in_hand"]:
                    # Score: prefer LOW pill confidence (hand truly empty)
                    # and HIGH hand visibility (clear proof hand returned)
                    emptiness = max(0, 1.0 - a["best_pill"])  # 0-1, higher = less pill
                    hand_visibility = min(1.0, a["hands"] * 0.5)  # more hands = better
                    # Prefer frames where hand is back in lower area (returned from mouth)
                    returned_bonus = max(0, a["hand_y"] - 0.3) * 0.5 if a["hand_y"] > 0.3 else 0
                    composite = emptiness * 0.6 + hand_visibility * 0.2 + returned_bonus * 0.2
                    if composite > best_p3_score:
                        best_p3_score = composite
                        p3_idx = i
                        p3_data = a

            if p3_data is None:
                print(f"[BatchAnalysis] No Phase 3 (hand back empty) after P2 at frame {p2_idx}")
                search_start = p2_idx + 1
                continue

            print(f"  [Phase3] OK Best hand-back-empty at frame {p3_idx} "
                  f"(pill={p3_data['best_pill']:.2f}, hands={p3_data['hands']}, "
                  f"in_hand={p3_data['pill_in_hand']}, score={best_p3_score:.2f})")

            # ── Verify chronological ordering: P1 < P2 < P3 ──────────
            p1_ts = p1_data.get("timestamp", "")
            p2_ts = p2_data.get("timestamp", "")
            p3_ts = p3_data.get("timestamp", "")
            if p1_ts and p2_ts and p3_ts:
                if not (p1_ts <= p2_ts <= p3_ts):
                    print(f"[BatchAnalysis] ✗ Timestamps out of order: P1={p1_ts} P2={p2_ts} P3={p3_ts} — rejecting")
                    search_start = p1_idx + 1
                    continue
            # Also verify frame indices are strictly ordered
            if not (p1_idx < p2_idx < p3_idx):
                print(f"[BatchAnalysis] ✗ Frame indices out of order: P1={p1_idx} P2={p2_idx} P3={p3_idx} — rejecting")
                search_start = p1_idx + 1
                continue

            # ── ALL 3 PHASES FOUND — compute confidence ───────────────
            pill_drop = p1_data["best_pill"] - p3_data["best_pill"]
            p1_score = p1_data["best_pill"]
            p3_score = min(1.0, max(0.70, pill_drop / max(0.01, p1_data["best_pill"])))

            # NOTE: a `p1_score = max(p1_score, 0.90)` floor used to sit here.
            # It overrode the measured pill confidence, so a single spurious
            # detection (observed: capsule=0.568 at the frame's bottom edge
            # during a laptop session) scored p1=0.90, p2=0.80, p3=1.00 and
            # produced exactly 0.904 — above the 0.85 auto-verify bar. That
            # constant was logged on three separate days. Dual confirmation
            # now adds a bounded bonus instead of replacing the measurement.
            if p1_data["pill_in_hand"] and p1_data["in_hand_count"] >= 1:
                p1_score = min(1.0, p1_score + 0.05)

            # All 3 phases contribute meaningfully to confidence
            weighted_avg = p1_score * 0.35 + p2_score * 0.30 + p3_score * 0.35
            min_core = min(p1_score, p3_score)
            confidence = weighted_avg * 0.80 + min_core * 0.20

            p1_kf_id = p1_data["kf"].get("id")
            p2_kf_id = p2_data["kf"].get("id")
            p3_kf_id = p3_data["kf"].get("id")

            phase_details = {
                "phase1_medicine_visible": {
                    "score": round(p1_score, 3), "pass": True,
                    "best_pill": round(p1_score, 3), "pill_in_hand": True,
                    "in_hand_count": p1_data["in_hand_count"],
                    "keyframe_id": p1_kf_id,
                    "frame_index": p1_idx,
                },
                "phase2_grip_and_motion": {
                    "score": round(p2_score, 3), "pass": True,
                    "motion": round(p2_data["motion"], 3),
                    "hand_y": round(p2_data["hand_y"], 3),
                    "keyframe_id": p2_kf_id,
                    "frame_index": p2_idx,
                },
                "phase3_medicine_gone": {
                    "score": round(p3_score, 3), "pass": True,
                    "pill_after": round(p3_data["best_pill"], 3),
                    "pill_drop": round(pill_drop, 3),
                    "keyframe_id": p3_kf_id,
                    "frame_index": p3_idx,
                    "_buffer_idx": p3_idx,  # used for buffer cleanup
                },
                "phases_passed": 3,
                "min_phase_score": round(min_core, 3),
                "weighted_avg": round(weighted_avg, 3),
            }

            classification = self.classify_event(confidence)

            result = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "final_confidence": round(confidence, 3),
                "frames_analyzed": len(analyzed),
                "phase_details": phase_details,
                **classification,
            }

            # Build evidence frames — one per phase with unique IDs and ordering
            import uuid as _uuid
            evidence_frames = []
            for phase_order, (role, kf_id, pdata, fidx) in enumerate([
                ("phase1_pill_visible", p1_kf_id, p1_data, p1_idx),
                ("phase2_grip_motion", p2_kf_id, p2_data, p2_idx),
                ("phase3_pill_gone", p3_kf_id, p3_data, p3_idx),
            ], start=1):
                used_ids = [e["id"] for e in evidence_frames]
                eid = kf_id or f"batch_{role}"
                if eid in used_ids:
                    eid = str(_uuid.uuid4())
                evidence_frames.append({
                    "id": eid, "frame": pdata["frame"],
                    "timestamp": pdata.get("timestamp", result["timestamp"]),
                    "phase_role": role,
                    "phase_order": phase_order,
                    "frame_index": fidx,
                })

            result["_evidence_frames"] = evidence_frames
            result["_p1_kf_id"] = p1_kf_id
            result["_in_hand_count"] = p1_data["in_hand_count"]
            self._attach_event_record(result, evidence_frames)

            seq_num = len(results) + 1
            print(f"\n{'='*50}")
            print(f"  BATCH ANALYSIS — Sequence #{seq_num}")
            print(f"  Phase 1 (pill in hand):    {p1_score:.2f} OK  [frame {p1_idx}]")
            print(f"  Phase 2 (hand to mouth):   {p2_score:.2f} OK  [frame {p2_idx}]")
            print(f"  Phase 3 (hand back empty): {p3_score:.2f} OK  [frame {p3_idx}]")
            print(f"  Pills in hand: {p1_data['in_hand_count']}")
            print(f"  Confidence: {confidence:.3f}")
            print(f"  Classification: {classification['classification']}")
            print(f"  Timestamps: P1={p1_ts[:19]} → P2={p2_ts[:19]} → P3={p3_ts[:19]}")
            print(f"{'='*50}\n")

            results.append(result)
            search_start = p3_idx + 1

        if not results:
            print("[BatchAnalysis] No complete 3-phase sequence found")
            
            # --- FALLBACK MECHANISM ---
            # If MediaPipe failed to detect hands (e.g. poor lighting, compressed stream),
            # but YOLO successfully detected a pill, we manually construct a sequence
            # from the best pill frames and let Gemini VLM verify it.
            if any_pill and len(analyzed) >= 3:
                print("[BatchAnalysis] FALLBACK: Pill detected but MediaPipe failed. Sending to Gemini VLM for verification.")
                import uuid as _uuid
                sorted_by_pill = sorted(analyzed, key=lambda x: x["best_pill"], reverse=True)
                top_3 = sorted(sorted_by_pill[:3], key=lambda x: analyzed.index(x))
                f1, f2, f3 = top_3[0], top_3[1], top_3[2]
                
                phase_details = {
                    "phase1_medicine_visible": {
                        "score": 0.50, "pass": True,
                        "best_pill": round(f1["best_pill"], 3), "pill_in_hand": False,
                        "in_hand_count": 0,
                        "keyframe_id": f1["kf"].get("id"),
                        "frame_index": analyzed.index(f1),
                    },
                    "phase2_grip_and_motion": {
                        "score": 0.50, "pass": True,
                        "motion": round(f2["motion"], 3),
                        "hand_y": round(f2["hand_y"], 3),
                        "keyframe_id": f2["kf"].get("id"),
                        "frame_index": analyzed.index(f2),
                    },
                    "phase3_medicine_gone": {
                        "score": 0.50, "pass": True,
                        "pill_after": round(f3["best_pill"], 3),
                        "pill_drop": 0.0,
                        "keyframe_id": f3["kf"].get("id"),
                        "frame_index": analyzed.index(f3),
                        "_buffer_idx": analyzed.index(f3),
                    },
                    "phases_passed": 3,
                    "min_phase_score": 0.50,
                    "weighted_avg": 0.50,
                }
                
                classification = self.classify_event(0.50)
                result = {
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    "final_confidence": 0.50,
                    "frames_analyzed": len(analyzed),
                    "phase_details": phase_details,
                    **classification,
                }
                
                evidence_frames = [
                    {"id": f1["kf"].get("id") or str(_uuid.uuid4()), "frame": f1["frame"], "timestamp": f1.get("timestamp"), "phase_role": "phase1_pill_visible", "phase_order": 1, "frame_index": analyzed.index(f1)},
                    {"id": f2["kf"].get("id") or str(_uuid.uuid4()), "frame": f2["frame"], "timestamp": f2.get("timestamp"), "phase_role": "phase2_grip_motion", "phase_order": 2, "frame_index": analyzed.index(f2)},
                    {"id": f3["kf"].get("id") or str(_uuid.uuid4()), "frame": f3["frame"], "timestamp": f3.get("timestamp"), "phase_role": "phase3_pill_gone", "phase_order": 3, "frame_index": analyzed.index(f3)}
                ]
                
                result["_evidence_frames"] = evidence_frames
                result["_p1_kf_id"] = f1["kf"].get("id")
                result["_in_hand_count"] = 1  # Assume 1 pill for fallback
                self._attach_event_record(result, evidence_frames)
                results.append(result)

            # Don't clear buffer — incomplete sequences need to stay
            # so Phase 2/3 can complete in the next batch run.
        else:
            # Only remove frames up to the last completed Phase 3.
            # This preserves any remaining frames for future sequences.
            last_p3_idx = max(
                r.get("phase_details", {}).get("phase3_medicine_gone", {}).get("_buffer_idx", 0)
                for r in results
            ) if results else 0
            # Remove completed frames from the front of the buffer
            with self.extractor._lock:
                # Remove frames that were part of completed sequences
                # The buffer is a deque, so we pop from the left
                to_remove = min(last_p3_idx + 1, len(self.extractor.buffer))
                for _ in range(to_remove):
                    if self.extractor.buffer:
                        self.extractor.buffer.popleft()
            print(f"[BatchAnalysis] Removed {to_remove} completed frames from buffer, "
                  f"{len(self.extractor.buffer)} remaining")

        return results

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
            _fps_start = time.time()

            while self.is_running:
                ret, frame = cap.read()
                if not ret:
                    # Stream dropped — always reconnect regardless of frame count
                    self.camera_online = False
                    if frame_count == 0:
                        if not getattr(self, '_offline_logged', False):
                            print(f"[Pipeline] ⚠ Camera offline ({source}). Waiting for stream...")
                            self._offline_logged = True
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
                        pass # Silently retry
                    continue
                else:
                    self.camera_online = True

                frame_count += 1
                if frame_count % 30 == 0:
                    elapsed = time.time() - _fps_start
                    fps = 30 / max(0.001, elapsed)
                    print(f"[Pipeline] Heartbeat: {frame_count} frames, {fps:.1f} fps")
                    _fps_start = time.time()

                # ── ADAPTIVE THROTTLE ───────────
                _now = time.time()
                if not hasattr(self, '_last_process_time'):
                    self._last_process_time = 0
                
                # FE-1 ceiling, from the extractor (a real property now: both
                # names in the old getattr chain were undefined, so this
                # silently pinned itself to the literal 5.0 fallback).
                fps_limit = self.extractor.current_fps
                _min_interval = 1.0 / max(1.0, float(fps_limit))
                
                if (_now - self._last_process_time) < _min_interval:
                    time.sleep(0.02)  # yield GIL
                    continue
                self._last_process_time = _now

                # Step 1: Always process frames — keyframe capture, face
                # recognition, and scene saving run continuously whenever
                # the stream is active. Medication-specific batch analysis
                # has its own guard (has_active_medication) inside the
                # batch block below.

                # Step 2: Buffer the frame for AI analysis
                keyframe = self.extractor.process_frame(frame)

                # ===========================================================
                # BATCH KEYFRAME ANALYSIS — runs every 5 seconds
                # Scans ALL recent keyframes for 3-phase medication sequence
                # ===========================================================

                # Initialize batch analysis state
                if not hasattr(self, '_batch_last_analysis'):
                    self._batch_last_analysis = 0
                    self._batch_busy = False

                # Run batch analysis every BATCH_ANALYSIS_FRAMES (30 s at 5 FPS),
                # which is exactly what the rolling buffer holds, so each pass
                # sees the whole window since the last one.
                # Skip entirely if all expected medicines are already verified
                # Skip if no medication is scheduled (no medication_ids or scheduled_time)
                all_meds_verified = (
                    self.expected_medicine_count > 0
                    and self.medicines_taken_count >= self.expected_medicine_count
                )
                has_active_medication = bool(self.medication_ids) and bool(self.scheduled_time)
                if (frame_count - self._batch_last_analysis >= BATCH_ANALYSIS_FRAMES
                        and not self._batch_busy
                        and not all_meds_verified
                        and has_active_medication):
                    self._batch_last_analysis = frame_count
                    self._batch_busy = True
                    print(f"[Pipeline] Launching batch analysis at frame {frame_count}...")

                    def _run_batch():
                        import time as _time
                        _t0 = _time.time()
                        try:
                            results = self.analyze_keyframes_batch()
                            _elapsed = _time.time() - _t0
                            print(f"[Pipeline] Batch analysis completed in {_elapsed:.1f}s, {len(results)} sequence(s) found")
                            if not results:
                                return

                            for seq_idx, result in enumerate(results):
                                confidence = result["final_confidence"]
                                classification = result["classification"]
                                evidence = result.get("_evidence_frames", [])
                                p1_kf_id = result.get("_p1_kf_id")
                                phases_passed = result.get("phase_details", {}).get("phases_passed", 0)

                                if phases_passed == 3 and confidence >= self.event_policy.auto_verify_threshold:
                                    # When pills are held together, body-cam YOLO often
                                    # merges them into one detection.  A complete 3-phase
                                    # sequence (pill-in-hand → motion → hand-back-empty)
                                    # verifies ALL remaining pills in one go.
                                    remaining = max(0, self.expected_medicine_count - self.medicines_taken_count)
                                    if remaining <= 0:
                                        print(f"[Pipeline] Sequence #{seq_idx+1}: All meds already verified — ignoring")
                                        continue
                                    
                                    # Use the actual number of pills detected in the hand (min 1, max remaining)
                                    detected_pills = result.get("_in_hand_count", 1)
                                    pills_to_log = min(remaining, max(1, detected_pills))

                                    self.medicines_detected_this_session.append({
                                        "timestamp": result["timestamp"], "pill_count": pills_to_log,
                                        "confidence": confidence, "classification": classification,
                                    })
                                    self.medicines_taken_count += pills_to_log
                                    print(f"[Pipeline] Sequence #{seq_idx+1}: Medicine auto-verified! "
                                          f"Pills: {pills_to_log}, Total: {self.medicines_taken_count}")

                                    self._log_detection_to_db_batch(
                                        status="taken", confidence=confidence, pills_to_log=pills_to_log,
                                        keyframe_id=p1_kf_id,
                                    )
                                    self._tag_detection_keyframes(result, confidence, "taken", frames=evidence)

                                elif phases_passed == 3 and confidence >= self.event_policy.confirmation_threshold:
                                    # 3-phase with moderate confidence → needs_verification
                                    # Log for ALL remaining medicines so they all appear
                                    #
                                    # Overlapping analysis passes re-detect the same
                                    # intake, so only log it once. A later pass that is
                                    # MORE confident still logs, since it supersedes the
                                    # earlier evidence; an equal or weaker repeat is
                                    # dropped. Without this the same swallow accumulated
                                    # a fresh set of evidence frames per pass.
                                    if self.needs_verification_conf is not None and                                             confidence <= self.needs_verification_conf:
                                        print(f"[Pipeline] Sequence #{seq_idx+1}: 3-phase detection "
                                              f"(conf={confidence:.2f}) already logged as "
                                              f"needs_verification at conf="
                                              f"{self.needs_verification_conf:.2f} — skipping duplicate")
                                        continue
                                    self.needs_verification_conf = confidence
                                    remaining_nv = max(1, self.expected_medicine_count - self.medicines_taken_count)
                                    print(f"[Pipeline] Sequence #{seq_idx+1}: 3-phase detection "
                                          f"(conf={confidence:.2f}). Logging {remaining_nv} as needs_verification.")
                                    self._log_detection_to_db_batch(
                                        status="needs_verification", confidence=confidence,
                                        pills_to_log=remaining_nv,
                                        keyframe_id=p1_kf_id,
                                    )
                                    self._tag_detection_keyframes(result, confidence, "needs_verification", frames=evidence)

                                # Cache best result
                                current_phases = result.get("phase_details", {}).get("phases_passed", 0)
                                last_phases = self.last_result.get("phase_details", {}).get("phases_passed", 0) if self.last_result else -1
                                if not self.last_result or current_phases > last_phases or \
                                   (current_phases == last_phases and confidence >= self.last_result.get("final_confidence", 0)):
                                    self.last_result = result

                            # Update counts on last result
                            if results:
                                results[-1]["medicines_taken_count"] = self.medicines_taken_count
                                results[-1]["expected_medicine_count"] = self.expected_medicine_count
                                results[-1]["medicines_remaining"] = max(0, self.expected_medicine_count - self.medicines_taken_count)

                            if self.expected_medicine_count > 0 and self.medicines_taken_count >= self.expected_medicine_count:
                                print(f"[Pipeline] All meds verified ({self.medicines_taken_count}/{self.expected_medicine_count}). Idling until rewatch.")
                                # Don't stop() — just clear the scheduled_time so the
                                # schedule-window check makes us idle. A rewatch will
                                # set scheduled_time again and reactivate scanning.
                                self.scheduled_time = ""
                                self.medication_ids = []
                                self.force_active = False  # stop bypassing schedule window

                        except Exception as e:
                            import traceback
                            print('[Pipeline Batch Error] ' + traceback.format_exc())
                        finally:
                            self._batch_busy = False

                    threading.Thread(target=_run_batch, daemon=True).start()

                # Run Face Recognition Plugin independently of medication results
                if self.face_plugin is not None and not getattr(self, '_face_busy', False):
                    def _run_face_batch():
                        self._face_busy = True
                        try:
                            face_buffer = list(self.extractor.buffer)
                            if face_buffer:
                                from .core.contracts import EventContext
                                ctx = EventContext(user_id=self.user_id, medication_ids=self.medication_ids)
                                face_result = self.face_plugin.analyze(face_buffer, ctx)
                                if face_result:
                                    self._log_face_result_to_db(face_result)
                        except Exception as e:
                            import traceback
                            print('[Face Recognition Error] ' + traceback.format_exc())
                        finally:
                            self._face_busy = False
                    
                    threading.Thread(target=_run_face_batch, daemon=True).start()

                # Run Egocentric Activity Plugin
                if self.activity_plugin is not None and not getattr(self, '_activity_busy', False):
                    def _run_activity_batch():
                        self._activity_busy = True
                        try:
                            act_buffer = list(self.extractor.buffer)
                            if act_buffer:
                                from .core.contracts import EventContext
                                ctx = EventContext(user_id=self.user_id)
                                act_result = self.activity_plugin.analyze(act_buffer, ctx)
                                # Per-frame activity claims ("Typing.", "Drinking.",
                                # "Using a phone.") are no longer logged. They inferred
                                # an ACTION from object presence in a single frame and
                                # hallucinated constantly: a bottle on a far table beat
                                # a laptop at 0.94 and logged "Drinking." while the
                                # wearer typed; the wearer holding a water bottle in
                                # both hands logged "Typing." because the bottle was not
                                # detected at all. The feed now carries environment
                                # sessions from Tier-2 instead (see ai/scene.py), which
                                # report a room over a span of time rather than an action
                                # in an instant. The plugin still runs because its
                                # result feeds Tier-2's metadata.
                                if act_result and EMIT_PER_FRAME_ACTIVITY_EVENTS:
                                    self._log_activity_result_to_db(act_result)
                        except Exception as e:
                            import traceback
                            print('[Activity Detection Error] ' + traceback.format_exc())
                        finally:
                            self._activity_busy = False
                    
                    threading.Thread(target=_run_activity_batch, daemon=True).start()

                # Display annotated frame if debugging
                if display:
                    annotated = frame.copy()
                    busy = getattr(self, '_batch_busy', False)
                    label = "ANALYZING..." if busy else "CAPTURING"
                    color = (0, 200, 255) if busy else (150, 150, 150)
                    cv2.putText(annotated, f"[{label}] Frame: {frame_count}",
                                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
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

            # ── FINAL SUMMARY — batch analysis results ─────────────────
            try:
                print(f"\n{'='*60}")
                print(f"FINAL SUMMARY (Pipeline Stopped)")
                print(f"{'='*60}")
                print(f"Medicines confirmed by batch analysis: {self.medicines_taken_count}")
                print(f"Expected medicines: {self.expected_medicine_count}")
                if self.last_result:
                    print(f"Last confidence: {self.last_result.get('final_confidence', 0):.2f}")
                    pd = self.last_result.get("phase_details", {})
                    print(f"Last phases passed: {pd.get('phases_passed', 0)}/3")

                if self.medicines_taken_count > 0:
                    print(f"[Pipeline] Batch analysis confirmed {self.medicines_taken_count} medicine(s).")
                elif self.expected_medicine_count > 0:
                    print(f"[Pipeline] No medication confirmed during this session.")
                    print(f"[Pipeline] The scheduler will handle missed-dose marking if needed.")
                else:
                    print("[Pipeline] No medication IDs configured — nothing to log.")
                print(f"{'='*60}\n")
            except Exception as e:
                print(f"[Pipeline] Final summary error: {e}")

            # Clean up resources
            cap.release()
            if display:
                try:
                    cv2.destroyAllWindows()
                except Exception:
                    pass

            # (Skip notifications are handled by the scheduler at the end of the time window)

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
                    "user_id": str(self.user_id),
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
            print(f"[Pipeline] All {expected} expected medicines taken. No skips.")

    def stop(self):
        self.is_running = False
        # Close the environment session that is still open (Core FE-2).
        # A session is only written when the room CHANGES, so whichever room
        # the wearer is in when the camera stops was never persisted -- and
        # flush_scene_sessions() existed with no caller anywhere, so the last
        # session of every run was silently discarded.
        try:
            from .item_indexer import DailyItemIndexer
            DailyItemIndexer.get_instance().flush_scene_sessions(str(self.user_id) if self.user_id else None)
        except Exception as e:
            print(f"[Pipeline] Could not flush environment sessions: {e}")