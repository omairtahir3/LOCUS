import cv2
import numpy as np
from collections import deque
from datetime import datetime, timezone, timedelta
import base64
import uuid
import os
import json
import threading
import time
import glob
from db_config import get_client, get_db_name

# Storage lives inside keyframe_backend/keyframe_storage/
KEYFRAME_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "keyframe_storage"
)

# Time-to-live: frames are auto-deleted after this many hours.
# FE-8 specifies 24-42 hours; 36 sits in the middle, so a frame captured at
# any hour survives at least a full day and night before it is swept.
# Flagged frames, and frames referenced by a relationship or an enrolled item,
# are kept regardless of age (see cleanup_expired).
KEYFRAME_TTL_HOURS = int(os.environ.get("KEYFRAME_TTL_HOURS", 36))


# ── Retention sweepers (Core FE-8) ──────────────────────────────────────────
#
# Retention used to be a side effect of WRITING. Each storage class started a
# cleanup thread in its constructor, and ActivityStorage / ItemStorage are only
# constructed when a frame is about to be saved. So when the camera stopped on
# 21 Sep 2026 those objects were never built, their sweepers never ran, and
# activities_storage kept 94 frames and items_storage 12 indefinitely -- while
# keyframe_storage, whose constructor runs on every /api/keyframes request, was
# swept clean. Frames outlived their TTL precisely because nothing was
# happening, which is the opposite of a retention guarantee.
#
# Sweepers are now keyed by directory and started once, and start_all_retention()
# starts every one at application boot whether or not anything is writing.
_SWEEPERS = {}
_SWEEPER_LOCK = threading.Lock()


def _start_sweeper(storage):
    """Start the cleanup loop for this storage's directory, once."""
    key = os.path.abspath(storage.storage_dir)
    with _SWEEPER_LOCK:
        existing = _SWEEPERS.get(key)
        if existing and existing.is_alive():
            return existing
        t = threading.Thread(target=storage._cleanup_loop, daemon=True,
                             name=f"sweep:{os.path.basename(key)}")
        t.start()
        _SWEEPERS[key] = t
        return t


def start_all_retention():
    """Bring every store under retention, regardless of write activity.

    Called once at startup. Constructing each storage is what registers and
    starts its sweeper; the objects themselves are discarded, because the
    writers build their own when they need to save.
    """
    started = []
    for cls in (KeyframeStorage, SocialInteractionStorage, ActivityStorage,
                ItemStorage, MedicationEvidenceStorage):
        try:
            cls()
            started.append(cls.__name__)
        except Exception as e:
            print(f"[Retention] could not start sweeper for {cls.__name__}: {e}")
    print(f"[Retention] active for {len(started)} stores, TTL {KEYFRAME_TTL_HOURS}h: "
          f"{', '.join(started)}")
    return started


class KeyframeStorage:
    """
    Persists keyframe images to disk with automatic TTL-based cleanup.
    
    Storage layout:
        keyframe_storage/
            <user_id>/
                <YYYY-MM-DD>/
                    <uuid>.jpg          — the frame image
                    <uuid>.json         — metadata (timestamp, motion_score, etc.)
    """

    def __init__(self, storage_dir=KEYFRAME_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        self.storage_dir = storage_dir
        self.ttl_hours = ttl_hours
        os.makedirs(self.storage_dir, exist_ok=True)

        # One sweeper per DIRECTORY, not per object. KeyframeStorage() is
        # constructed on every /api/keyframes request, every pipeline start and
        # every face-plugin init, so this used to spawn a fresh cleanup thread
        # each time -- dozens of threads all scanning the same folder.
        self._cleanup_thread = _start_sweeper(self)
        print(f"[{self.__class__.__name__}] Initialized at: {self.storage_dir}")

        

    def save(self, keyframe_id, frame, metadata):

        uid = str(metadata.get("user_id", "unknown"))

        today = datetime.now().strftime("%Y-%m-%d")

        user_dir = os.path.join(self.storage_dir, uid, today)

        os.makedirs(user_dir, exist_ok=True)

        img_path  = os.path.join(user_dir, f"{keyframe_id}.jpg")

        meta_path = os.path.join(user_dir, f"{keyframe_id}.json")



        success = cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

        if not success:

            print(f"[KeyframeStorage.save] ✗ ERROR: Failed to write image to {img_path}")

        else:

            print(f"[KeyframeStorage] Successfully saved frame to: {img_path}")

            print(f"[KeyframeStorage.save] OK Saved {keyframe_id}.jpg for user={uid}")



        meta = {

            **metadata,

            "file": f"{keyframe_id}.jpg",

            "saved_at": datetime.now().astimezone().isoformat(),

        }

        try:
            with open(meta_path, "w") as f:
                json.dump(meta, f, indent=2)
        except Exception as e:
            print(f"[KeyframeStorage.save] ✗ ERROR writing metadata: {e}")

        # Tier-2 Asynchronous Daily Life Item Indexer.
        # Import via ONE path only. Python caches modules by import path, so
        # importing this as both `ai.item_indexer` and
        # `ai_backend.detection_pipeline.ai.item_indexer` produced two distinct
        # module objects — two singletons, two worker threads, two model loads,
        # and two independent dedup dicts, which silently bypassed the 120s
        # enrichment window (observed: duplicate "Eating" events in the same second).
        try:
            from ai.item_indexer import DailyItemIndexer
            DailyItemIndexer.get_instance().enqueue_keyframe(keyframe_id, frame, metadata)
        except Exception as e:
            print(f"[KeyframeStorage] Item indexer enqueue failed: {e}")



    def load_frame(self, keyframe_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.jpg"))

        if matches: return cv2.imread(matches[0])

        legacy = os.path.join(self.storage_dir, f"{keyframe_id}.jpg")

        if os.path.exists(legacy): return cv2.imread(legacy)

        return None



    def load_metadata(self, keyframe_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.json"))

        if matches:

            with open(matches[0], "r") as f: return json.load(f)

        legacy = os.path.join(self.storage_dir, f"{keyframe_id}.json")

        if os.path.exists(legacy):

            with open(legacy, "r") as f: return json.load(f)

        return None



    def list_keyframes(self, user_id=None, medication_only=False, limit=200):

        entries = []

        try:
            user_dirs = [os.path.join(self.storage_dir, str(user_id))] if user_id else [f.path for f in os.scandir(self.storage_dir) if f.is_dir()]
            for u_dir in user_dirs:
                if not os.path.exists(u_dir): continue
                for d_dir in os.scandir(u_dir):
                    if not d_dir.is_dir(): continue
                    for entry in os.scandir(d_dir.path):
                        if entry.is_file() and entry.name.endswith('.json'):
                            try:
                                entries.append((entry.stat().st_mtime, entry.path, d_dir.name))
                            except OSError:
                                pass
            
            # Legacy flat files
            if not user_id:
                for entry in os.scandir(self.storage_dir):
                    if entry.is_file() and entry.name.endswith('.json'):
                        try: entries.append((entry.stat().st_mtime, entry.path, "unknown_date"))
                        except OSError: pass
        except OSError:
            pass

        entries.sort(key=lambda x: x[0], reverse=True)

        keyframes = []
        for _mtime, meta_path, date_str in entries:
            if len(keyframes) >= limit:
                break
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
                    meta["keyframe_id"] = os.path.basename(meta_path).replace(".json", "")
                    meta["date"] = date_str
                    if "timestamp" in meta and "saved_at" not in meta:
                        meta["saved_at"] = meta["timestamp"]

                    if medication_only and not meta.get("medication_detected"):
                        continue
                        
                    stored_uid = meta.get("user_id", "")
                    if user_id and stored_uid and str(stored_uid) != str(user_id):
                        continue

                    keyframes.append(meta)
            except (json.JSONDecodeError, IOError):
                continue
        keyframes.sort(key=lambda k: k.get("saved_at", ""), reverse=True)
        return keyframes



    def tag_as_medication_detected(self, keyframe_id, confidence=0.0, status="taken",

                                    medication_name="", medication_id=""):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.json"))

        meta_path = matches[0] if matches else os.path.join(self.storage_dir, f"{keyframe_id}.json")

        if not os.path.exists(meta_path): return False

        try:

            with open(meta_path, "r") as f: meta = json.load(f)

            meta["medication_detected"] = True

            meta["detection_confidence"] = round(confidence, 3)

            meta["detection_status"] = status

            meta["medication_name"] = medication_name

            meta["medication_id"] = medication_id

            meta["detected_at"] = datetime.now().astimezone().isoformat()

            with open(meta_path, "w") as f: json.dump(meta, f, indent=2)

            return True

        except Exception as e:

            print(f"[KeyframeStorage] Tag error for {keyframe_id}: {e}")

            return False




    def cleanup_expired(self):
        now_utc = datetime.now(timezone.utc)
        cutoff = now_utc - timedelta(hours=self.ttl_hours)
        deleted = 0

        expired_kids = []
        meta_paths_map = {}

        def _gather_expired(meta_path):
            try:
                import json, os
                with open(meta_path, "r") as f: meta = json.load(f)
                saved_at = meta.get("saved_at", "")
                if not saved_at: return
                frame_time = datetime.fromisoformat(saved_at)
                if frame_time.tzinfo is None: frame_time = frame_time.astimezone(timezone.utc)
                else: frame_time = frame_time.astimezone(timezone.utc)
                
                if frame_time < cutoff:
                    kid = os.path.basename(meta_path).replace(".json", "")
                    expired_kids.append(kid)
                    meta_paths_map[kid] = meta_path
            except Exception:
                pass

        # Gather
        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):
            if not os.path.isdir(u_dir): continue
            for d_dir in glob.glob(os.path.join(u_dir, "*")):
                if not os.path.isdir(d_dir): continue
                for meta_path in glob.glob(os.path.join(d_dir, "*.json")):
                    _gather_expired(meta_path)
                    
        for meta_path in glob.glob(os.path.join(self.storage_dir, "*.json")):
            _gather_expired(meta_path)

        if not expired_kids:
            return 0

        # Batch retention check
        retained_kids = set()
        try:
            from pymongo import MongoClient
            client = get_client()
            db = client[get_db_name()]
            
            # Check event logs (keyframe_ref or keyframe_id might be used, check both)
            events = db.eventlogs.find({"keyframe_id": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_id": 1})
            for e in events:
                if e.get("keyframe_id"): retained_kids.add(e.get("keyframe_id"))

            events_ref = db.eventlogs.find({"keyframe_ref": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_ref": 1})
            for e in events_ref:
                if e.get("keyframe_ref"): retained_kids.add(e.get("keyframe_ref"))
                
            # Check medication logs
            med_logs = db.medication_logs.find({"keyframe_id": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_id": 1})
            for m in med_logs:
                if m.get("keyframe_id"): retained_kids.add(m.get("keyframe_id"))
                
            # Check relationship representative images
            rels = db.relationships.find({"representative_keyframe_id": {"$in": expired_kids}}, {"representative_keyframe_id": 1})
            for r in rels:
                if r.get("representative_keyframe_id"): retained_kids.add(r.get("representative_keyframe_id"))
                
            # Check user items representative images
            user_items = db.useritems.find({"representative_keyframe_id": {"$in": expired_kids}}, {"representative_keyframe_id": 1})
            for u in user_items:
                if u.get("representative_keyframe_id"): retained_kids.add(u.get("representative_keyframe_id"))
                
            client.close()
        except Exception as e:
            print(f"[Storage] DB Error during cleanup retention check: {e}")

        # Delete non-retained
        for kid in expired_kids:
            if kid in retained_kids:
                continue
            meta_path = meta_paths_map[kid]
            img_path = os.path.join(os.path.dirname(meta_path), f"{kid}.jpg")
            try:
                if os.path.exists(img_path): os.remove(img_path)
                if os.path.exists(meta_path): os.remove(meta_path)
                deleted += 1
            except Exception:
                pass

        # Cleanup empty dirs safely
        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):
            if not os.path.isdir(u_dir): continue
            for d_dir in glob.glob(os.path.join(u_dir, "*")):
                if not os.path.isdir(d_dir): continue
                if not os.listdir(d_dir): 
                    try:
                        folder_date = datetime.strptime(os.path.basename(d_dir), "%Y-%m-%d").replace(tzinfo=timezone.utc)
                        if folder_date < cutoff - timedelta(days=2):
                            os.rmdir(d_dir)
                    except Exception:
                        pass

        if deleted > 0:
            print(f"[{self.__class__.__name__}] Cleaned up {deleted} expired frame(s)")
        return deleted




    def _cleanup_loop(self):
        # Run cleanup immediately on startup, then every 30 minutes
        while True:
            try: self.cleanup_expired()
            except Exception as e: print(f"[KeyframeStorage] Cleanup error: {e}")
            time.sleep(30 * 60)





# Evidence storage lives inside keyframe_backend/
SOCIAL_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "social_storage"
)

class SocialInteractionStorage(KeyframeStorage):
    """
    Persists social interaction frames to disk.
    Storage layout:
        social_storage/
            <user_id>/
                <YYYY-MM-DD>/
                    <uuid>.jpg
                    <uuid>.json
    """
    def __init__(self, storage_dir=SOCIAL_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        super().__init__(storage_dir=storage_dir, ttl_hours=ttl_hours)


ACTIVITY_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "activities_storage"
)

class ActivityStorage(KeyframeStorage):
    """
    Persists activity detection frames to disk.
    Storage layout:
        activities_storage/
            <user_id>/
                <YYYY-MM-DD>/
                    <uuid>.jpg
                    <uuid>.json
    """
    def __init__(self, storage_dir=ACTIVITY_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        super().__init__(storage_dir=storage_dir, ttl_hours=ttl_hours)


ITEMS_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "items_storage"
)

class ItemStorage(KeyframeStorage):
    """
    Persists personal belongings item detection keyframes to disk.
    Storage layout:
        items_storage/
            <user_id>/
                <YYYY-MM-DD>/
                    <uuid>.jpg
                    <uuid>.json
    """
    def __init__(self, storage_dir=ITEMS_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        super().__init__(storage_dir=storage_dir, ttl_hours=ttl_hours)


MEDICATION_EVIDENCE_STORAGE_DIR = os.path.join(

    os.path.dirname(os.path.abspath(__file__)),

    "medications_storage"

)





class MedicationEvidenceStorage:

    """

    Persists medicine evidence frame images to disk.

    Metadata is saved to a flat .json file (currently)

    and eventually to MongoDB (eventlogs).

    

    Storage layout:

        medications_storage/

            <user_id>/

                <YYYY-MM-DD>/

                    <uuid>.jpg          - the evidence frame image

                    <uuid>.json         - the evidence metadata

    """



    def __init__(self, storage_dir=MEDICATION_EVIDENCE_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):

        self.storage_dir = storage_dir

        self.ttl_hours = ttl_hours

        os.makedirs(self.storage_dir, exist_ok=True)

        # Same single-sweeper-per-directory rule as KeyframeStorage.
        self._cleanup_thread = _start_sweeper(self)
        print(f"[EvidenceStorage] Initialized at: {self.storage_dir}")



    def save(self, evidence_id, frame, metadata):

        uid = str(metadata.get("user_id", "unknown"))

        today = datetime.now().strftime("%Y-%m-%d")

        user_dir = os.path.join(self.storage_dir, uid, today)

        os.makedirs(user_dir, exist_ok=True)

        img_path  = os.path.join(user_dir, f"{evidence_id}.jpg")

        meta_path = os.path.join(user_dir, f"{evidence_id}.json")



        success = cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])

        if not success:

            print(f"[EvidenceStorage] ERROR: Failed to write image {evidence_id}")



        meta = {

            **metadata,

            "file": f"{evidence_id}.jpg",

            "saved_at": datetime.now().astimezone().isoformat(),

        }

        with open(meta_path, "w") as f:

            json.dump(meta, f, indent=2)



    def load_frame(self, evidence_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{evidence_id}.jpg"))

        if matches: return cv2.imread(matches[0])

        legacy = os.path.join(self.storage_dir, f"{evidence_id}.jpg")

        if os.path.exists(legacy): return cv2.imread(legacy)

        return None



    def load_metadata(self, evidence_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{evidence_id}.json"))

        if matches:

            with open(matches[0], "r") as f: return json.load(f)

        legacy = os.path.join(self.storage_dir, f"{evidence_id}.json")

        if os.path.exists(legacy):

            with open(legacy, "r") as f: return json.load(f)

        return None



    def list_evidence(self, user_id=None, limit=100):

        entries = []

        try:
            user_dirs = [os.path.join(self.storage_dir, str(user_id))] if user_id else [f.path for f in os.scandir(self.storage_dir) if f.is_dir()]
            for u_dir in user_dirs:
                if not os.path.exists(u_dir): continue
                for d_dir in os.scandir(u_dir):
                    if not d_dir.is_dir(): continue
                    for entry in os.scandir(d_dir.path):
                        if entry.is_file() and entry.name.endswith('.json'):
                            try:
                                entries.append((entry.stat().st_mtime, entry.path, d_dir.name))
                            except OSError:
                                pass
            
            if not user_id:
                for entry in os.scandir(self.storage_dir):
                    if entry.is_file() and entry.name.endswith('.json'):
                        try: entries.append((entry.stat().st_mtime, entry.path, "unknown_date"))
                        except OSError: pass
        except OSError:
            pass



        entries.sort(key=lambda x: x[0], reverse=True)



        evidence = []

        for _mtime, meta_path, date_str in entries:

            if len(evidence) >= limit: break

            try:

                with open(meta_path, "r") as f:

                    meta = json.load(f)

                    meta["evidence_id"] = os.path.basename(meta_path).replace(".json", "")
                    meta["date"] = date_str
                    if "timestamp" in meta and "saved_at" not in meta:
                        meta["saved_at"] = meta["timestamp"]



                    stored_uid = meta.get("user_id", "")

                    if user_id and stored_uid and str(stored_uid) != str(user_id):

                        continue



                    evidence.append(meta)

            except (json.JSONDecodeError, IOError):

                continue

        evidence.sort(key=lambda e: e.get("saved_at", ""), reverse=True)

        return evidence




    def cleanup_expired(self):
        now_utc = datetime.now(timezone.utc)
        cutoff = now_utc - timedelta(hours=self.ttl_hours)
        deleted = 0

        expired_kids = []
        meta_paths_map = {}

        def _gather_expired(meta_path):
            try:
                import json, os
                with open(meta_path, "r") as f: meta = json.load(f)
                saved_at = meta.get("saved_at", "")
                if not saved_at: return
                frame_time = datetime.fromisoformat(saved_at)
                if frame_time.tzinfo is None: frame_time = frame_time.astimezone(timezone.utc)
                else: frame_time = frame_time.astimezone(timezone.utc)
                
                if frame_time < cutoff:
                    kid = os.path.basename(meta_path).replace(".json", "")
                    expired_kids.append(kid)
                    meta_paths_map[kid] = meta_path
            except Exception:
                pass

        # Gather
        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):
            if not os.path.isdir(u_dir): continue
            for d_dir in glob.glob(os.path.join(u_dir, "*")):
                if not os.path.isdir(d_dir): continue
                for meta_path in glob.glob(os.path.join(d_dir, "*.json")):
                    _gather_expired(meta_path)
                    
        for meta_path in glob.glob(os.path.join(self.storage_dir, "*.json")):
            _gather_expired(meta_path)

        if not expired_kids:
            return 0

        # Batch retention check
        retained_kids = set()
        try:
            from pymongo import MongoClient
            client = get_client()
            db = client[get_db_name()]
            
            # Check event logs (keyframe_ref or keyframe_id might be used, check both)
            events = db.eventlogs.find({"keyframe_id": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_id": 1})
            for e in events:
                if e.get("keyframe_id"): retained_kids.add(e.get("keyframe_id"))

            events_ref = db.eventlogs.find({"keyframe_ref": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_ref": 1})
            for e in events_ref:
                if e.get("keyframe_ref"): retained_kids.add(e.get("keyframe_ref"))
                
            # Check medication logs
            med_logs = db.medication_logs.find({"keyframe_id": {"$in": expired_kids}, "is_flagged": True}, {"keyframe_id": 1})
            for m in med_logs:
                if m.get("keyframe_id"): retained_kids.add(m.get("keyframe_id"))
                
            # Check relationship representative images
            rels = db.relationships.find({"representative_keyframe_id": {"$in": expired_kids}}, {"representative_keyframe_id": 1})
            for r in rels:
                if r.get("representative_keyframe_id"): retained_kids.add(r.get("representative_keyframe_id"))
                
            client.close()
        except Exception as e:
            print(f"[Storage] DB Error during cleanup retention check: {e}")

        # Delete non-retained
        for kid in expired_kids:
            if kid in retained_kids:
                continue
            meta_path = meta_paths_map[kid]
            img_path = os.path.join(os.path.dirname(meta_path), f"{kid}.jpg")
            try:
                if os.path.exists(img_path): os.remove(img_path)
                if os.path.exists(meta_path): os.remove(meta_path)
                deleted += 1
            except Exception:
                pass

        # Cleanup empty dirs safely
        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):
            if not os.path.isdir(u_dir): continue
            for d_dir in glob.glob(os.path.join(u_dir, "*")):
                if not os.path.isdir(d_dir): continue
                if not os.listdir(d_dir): 
                    try:
                        folder_date = datetime.strptime(os.path.basename(d_dir), "%Y-%m-%d").replace(tzinfo=timezone.utc)
                        if folder_date < cutoff - timedelta(days=2):
                            os.rmdir(d_dir)
                    except Exception:
                        pass

        if deleted > 0:
            print(f"[{self.__class__.__name__}] Cleaned up {deleted} expired frame(s)")
        return deleted




    def _cleanup_loop(self):
        # Run cleanup immediately on startup, then every 30 minutes
        while True:
            try: self.cleanup_expired()
            except Exception as e: print(f"[EvidenceStorage] Cleanup error: {e}")
            time.sleep(30 * 60)







class KeyframeExtractor:

    """

    Extracts keyframes from video feed at adaptive FPS.

    Increases capture rate during motion, reduces during inactivity.

    Maintains a 5-10 second temporal buffer for sequence analysis.



    Quality filtering:

    - AI Pipeline: Uses all adaptive motion-captured frames, even if blurry.

    - Disk Storage: Saves only the sharpest (highest Laplacian variance) frame

      per 1-second window.

    """



    def __init__(self, target_fps=5, buffer_seconds=5, save_locally=True,

                 blur_threshold=15.0, window_duration=1.0, top_n_per_window=5,

                 max_buffer_frames=300, user_id=""):

        # FE-1: the CEILING, in frames per second. The pipeline throttles to
        # this, and should_capture() then reduces below it when there is no
        # motion, so the effective rate rises and falls between roughly
        # target_fps/6 (idle) and target_fps (motion). Read through the
        # current_fps property, which is what the pipeline asks for.
        self.target_fps = target_fps

        # FE-3: how much history the rolling buffer holds. The deque is sized
        # from this and target_fps rather than from a raw frame count, so the
        # window stays the same length in SECONDS if the rate changes.
        self.buffer_seconds = buffer_seconds

        self.user_id = user_id

        # Buffer holds recent frames for AI analysis.

        # Capped at max_buffer_frames to prevent memory exhaustion

        # during long sessions (e.g. 5-6 hour GoPro recording).

        # 300 frames â‰ˆ 10 seconds at 30fps â€” plenty for phase analysis.

        # Derived from seconds so the window cannot silently drift when the
        # rate changes. max_buffer_frames, if passed, is only an upper bound
        # for memory safety on a long session.
        self.max_buffer_frames = min(max_buffer_frames, int(buffer_seconds * target_fps))

        self.buffer = deque(maxlen=self.max_buffer_frames)

        self._lock = threading.Lock()

        self.prev_frame = None

        self.motion_threshold = 10

        self.frame_count = 0

        # Capture state overrides
        self.active_event = False
        self.person_present = False

        self.blur_threshold = blur_threshold



        # Smart scene logic configuration
        self._last_scene_save_time = 0.0
        self.scene_cooldown_seconds = 10.0
        self.scene_motion_threshold = 15.0
        self.on_scene_saved = None

        # Local storage
        self.save_locally = save_locally
        self.storage = KeyframeStorage() if save_locally else None

    @property
    def current_fps(self):
        """The rate the pipeline should throttle to (FE-1's ceiling).

        This used to be read with getattr(self.extractor, "current_fps",
        getattr(self, "max_processing_fps", 5.0)) -- and NEITHER name existed,
        so the throttle silently fell back to the literal 5.0 and target_fps
        was dead code. The ceiling is a real, configurable value now.
        """
        return float(self.target_fps)

    def compute_motion_score(self, frame):

        """Compare current frame to previous to detect motion level."""

        if self.prev_frame is None:

            self.prev_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

            return 0



        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        diff = cv2.absdiff(self.prev_frame, gray)

        score = np.mean(diff)

        self.prev_frame = gray

        return score



    def compute_blur_score(self, frame):

        """

        Compute image sharpness using Laplacian variance.

        Higher score = sharper image.

        Typical values: <50 very blurry, 50-100 soft, >100 sharp.

        """

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        return float(cv2.Laplacian(gray, cv2.CV_64F).var())



    def should_capture(self, motion_score):
        """
        Priority-ordered capture decision:
          1. Active event -> ALWAYS capture (regardless of motion)
          2. Motion detected -> capture (bootstraps detection)
          3. Person present -> capture every 3 frames (idle but face in view)
          4. Idle -> throttle to 1-in-6
        """
        # Priority 1: Active event forces full rate, motion is irrelevant
        if getattr(self, 'active_event', False):
            return True

        # Priority 2: Motion bootstraps detection
        if motion_score > self.motion_threshold:
            return True

        # Priority 3: Person present but idle (no motion, but face detected recently)
        if getattr(self, 'person_present', False):
            return self.frame_count % 3 == 0

        # Priority 4: Idle - minimal capture rate
        return self.frame_count % 6 == 0



    def extract_keyframe(self, frame, motion_score, blur_score):

        """

        Package a frame into a keyframe record and add to in-memory buffer.

        Does NOT save to disk â€” disk persistence is handled by the

        best-frame-per-window logic in process_frame().

        """

        keyframe_id = str(uuid.uuid4())

        timestamp = datetime.now(timezone.utc).isoformat()



        _, jpg_buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

        encoded = base64.b64encode(jpg_buffer).decode('utf-8')



        keyframe = {

            "id": keyframe_id,

            "timestamp": timestamp,

            "motion_score": round(float(motion_score), 2),

            "blur_score": round(blur_score, 2),

            "frame_data": encoded,  # base64 encoded JPEG (in-memory buffer)

            "width": frame.shape[1],

            "height": frame.shape[0],

        }

        self.buffer.append(keyframe)



        return keyframe



    def _save_scene_async(self, keyframe_id, frame, metadata, motion_score):
        try:
            self.storage.save(keyframe_id, frame, metadata)
            if self.on_scene_saved:
                self.on_scene_saved(keyframe_id, motion_score)
        except Exception as e:
            print(f"[KeyframeExtractor] ERROR saving scene {keyframe_id}: {e}")



    def flush_remaining(self):
        """Flushes any pending scene captures to disk when stopping."""
        if getattr(self, '_pending_scene_capture', False) and hasattr(self, '_scene_capture_frames') and self._scene_capture_frames:
            import threading, time
            best = max(self._scene_capture_frames, key=lambda x: x['blur_score'])
            metadata = {
                "id": best['keyframe_id'],
                "timestamp": time.time(),
                "blur_score": best['blur_score'],
                "motion_score": best['motion_score'],
                "type": "scene_capture",
                "user_id": self.user_id
            }
            print(f"[KeyframeExtractor] Flushing remaining scene capture: {best['keyframe_id']}")
            t = threading.Thread(target=self._save_scene_async, args=(best['keyframe_id'], best['frame'], metadata, best['motion_score']), daemon=True)
            t.start()
            self._pending_scene_capture = False
            self._scene_capture_frames = []

    def get_buffer(self):

        """Return current temporal buffer as list (thread-safe)."""

        with self._lock:

            return list(self.buffer)



    def get_frames_for_analysis(self):

        """

        Return frames from buffer for model inference (thread-safe).

        Caps to MAX_ANALYSIS_FRAMES by striding through the buffer.

        The temporal phase analysis only needs ~15 well-distributed

        frames to detect the pillâ†’gripâ†’gone sequence.

        """

        MAX_ANALYSIS_FRAMES = 15



        with self._lock:

            snapshot = list(self.buffer)

        if not snapshot:

            return []



        n = len(snapshot)



        # If buffer is small enough, use all frames

        if n <= MAX_ANALYSIS_FRAMES:

            selected = snapshot

        else:

            # Stride through buffer to pick evenly-spaced frames

            step = n / MAX_ANALYSIS_FRAMES

            indices = [int(i * step) for i in range(MAX_ANALYSIS_FRAMES)]

            # Always include last frame

            if indices[-1] != n - 1:

                indices[-1] = n - 1

            selected = [snapshot[i] for i in indices]



        frames = []

        for kf in selected:

            frame = kf["raw_frame"]

            frames.append({"frame": frame, "timestamp": kf["timestamp"], "id": kf["id"]})



        print(f"[Analysis] Analyzing {len(frames)} frames (from {n} in buffer)")

        return frames





    def process_frame(self, frame):

        """

        Main method â€” call for every frame from the camera.



        1. ALL frames go into in-memory buffer for AI analysis.

        2. Frames are saved to disk every 1-second window.



        Optimized: blur score only computed every 3rd frame,

        motion uses downscaled comparison, disk writes are async.

        """

        self.frame_count += 1

        if self.frame_count % 100 == 0:

            print(f"[KeyframeExtractor] Processed {self.frame_count} frames... (Buffer: {len(self.buffer)})")



        # Fast motion check: use downscaled grayscale (4x smaller)

        small = cv2.resize(frame, (frame.shape[1] // 4, frame.shape[0] // 4))

        gray_small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        if self.prev_frame is None:

            self.prev_frame = gray_small

            motion_score = 0

        else:
            diff = cv2.absdiff(self.prev_frame, gray_small)
            motion_score = float(np.mean(diff))
            self.prev_frame = gray_small
            
        import time as _t
        now_fps = _t.time()
        if not hasattr(self, '_fps_log_time'):
            self._fps_log_time = now_fps
            self._fps_frames = 0
        self._fps_frames += 1
        if now_fps - self._fps_log_time >= 1.0:
            print(f"[DEBUG-FPS] Captured {self._fps_frames} frames in the last second. Current motion: {motion_score:.2f}")
            self._fps_log_time = now_fps
            self._fps_frames = 0



        # Blur score: compute for every frame to avoid stale scores during fast motion
        blur_score = self.compute_blur_score(frame)
        self._last_blur_score = blur_score



        keyframe_id = str(uuid.uuid4())

        timestamp = datetime.now().astimezone().isoformat()


        # 1. Smart Scene disk saving
        if self.save_locally and self.storage:
            now = time.time()
            if motion_score > self.scene_motion_threshold and (now - self._last_scene_save_time) >= self.scene_cooldown_seconds:
                self._pending_scene_capture = True
                if not hasattr(self, '_scene_capture_frames'):
                    self._scene_capture_frames = []
            
            if getattr(self, '_pending_scene_capture', False):
                self._scene_capture_frames.append({
                    'frame': frame.copy(),
                    'blur_score': blur_score,
                    'motion_score': motion_score,
                    'timestamp': timestamp,
                    'keyframe_id': keyframe_id
                })
                # Wait 15 frames (~0.5s) for motion to settle, then pick sharpest
                if len(self._scene_capture_frames) >= 15:
                    best = max(self._scene_capture_frames, key=lambda x: x['blur_score'])
                    
                    # LOGGING 15 SCORES
                    print("\n[KeyframeExtractor] --- BURST CAPTURE (15 frames) ---")
                    for i, f in enumerate(self._scene_capture_frames):
                        is_best = " <--- SELECTED" if f['keyframe_id'] == best['keyframe_id'] else ""
                        print(f"  Frame {i+1}: blur_score = {f['blur_score']:.2f}{is_best}")
                    print(f"[KeyframeExtractor] Best Score: {best['blur_score']:.2f} (Threshold: {self.blur_threshold})")
                    
                    if best['blur_score'] < self.blur_threshold:
                        print(f"[KeyframeExtractor] Scene capture rejected due to blur: {best['blur_score']} < {self.blur_threshold}")
                        self._scene_capture_frames = []
                        self._pending_scene_capture = False
                    else:
                        self._last_scene_save_time = now
                        metadata = {
                            "id": best['keyframe_id'],
                            "timestamp": best['timestamp'],
                            "motion_score": round(float(best['motion_score']), 2),
                            "blur_score": round(float(best['blur_score']), 2),
                            "width": best['frame'].shape[1],
                            "height": best['frame'].shape[0],
                            "user_id": getattr(self, "user_id", ""),
                            "event_type": "scene_change"
                        }
                        t = threading.Thread(target=self._save_scene_async, args=(best['keyframe_id'], best['frame'], metadata, best['motion_score']), daemon=True)
                        t.start()
                        self._pending_scene_capture = False
                        self._scene_capture_frames = []



        # 2. AI buffer: Only append frames that pass the adaptive capture check
        if not self.should_capture(motion_score):
            return None

        keyframe = {
            "id": keyframe_id,
            "timestamp": timestamp,
            "motion_score": round(float(motion_score), 2),
            "blur_score": round(blur_score, 2),
            "raw_frame": frame,
            "width": frame.shape[1],
            "height": frame.shape[0],
        }

        with self._lock:
            self.buffer.append(keyframe)

        return keyframe





import threading

import time



class VideoSource:

    """

    Thread-safe video source wrapper for webcam, file, RTSP, RTMP.

    For live streams (RTSP/RTMP), uses a background thread to read frames

    and cache the latest one. Main thread reads via .read().

    Key: Return the LATEST frame (even if not new), don't break on stale frames.

    """

    def __init__(self, source=0):

        """source=0 for webcam, path/to/video.mp4 for file, rtmp://... for live stream"""

        print(f"[Profiling] VideoSource init started for {source} at {time.time()}")
        self.source = source

        self.cap = None

        self._is_gopro = False

        self._is_live = isinstance(source, int) or (isinstance(source, str) and ("rtmp://" in source or "rtsp://" in source or "gopro" in source.lower()))

        self._running = False

        self._thread = None

        

        # Live stream frame caching with simple lock

        self._frame_lock = threading.Lock()

        self._ret = False

        self._frame = None

        self._stream_dead = False

        self._last_frame_time = 0



    def open(self):

        if isinstance(self.source, str) and self.source.lower() == "gopro":

            from ai.gopro import GoProSource

            self.cap = GoProSource()

            self.cap.open()

            self._is_gopro = True

            

            # Start background reader for GoPro WiFi stream

            self._running = True

            self._thread = threading.Thread(target=self._update, daemon=True)

            self._thread.start()

        else:

            # Optimize OpenCV for RTMP/RTSP streams

            if isinstance(self.source, str) and ("rtmp://" in self.source or "rtsp://" in self.source):

                import os

                # Force TCP transport for RTSP to prevent H264 decode errors from UDP packet loss
                # Increase probesize (2MB) for stable stream init, increase stimeout to 20s for slow streams
                # Add fflags;nobuffer and flags;low_delay to ensure data flows immediately (no buffering)
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (

                    "rtsp_transport;tcp|analyzeduration;2000000|probesize;2000000|stimeout;20000000|fflags;nobuffer|flags;low_delay"

                )
                print(f"[VideoSource] FFMPEG options configured for RTMP/RTSP reliability")

                

            self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)

            if getattr(cv2, 'CAP_PROP_BUFFERSIZE', None) is not None:

                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)



            # Retry for RTSP/RTMP streams â€” the publisher (GoPro) may not be live yet

            if not self.cap.isOpened() and self._is_live:
                # Retry for ~35 seconds total
                # First 20 attempts at 0.5s intervals (10s)
                # Next 10 attempts at 2.5s intervals (25s)
                attempts = 0
                while not self.cap.isOpened() and attempts < 30:
                    attempts += 1
                    sleep_time = 0.5 if attempts <= 20 else 2.5
                    
                    if attempts == 1 or attempts == 21 or attempts == 30:
                        print(f"[VideoSource] Stream not available, retrying... (attempt {attempts}/30, sleep {sleep_time}s)")
                        
                    time.sleep(sleep_time)
                    self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)
                    
                    if self.cap.isOpened():
                        print(f"[VideoSource] OK Stream connected on attempt {attempts}")
                        break

            

            if not self.cap.isOpened():

                raise RuntimeError(f"Could not open video source: {self.source}. Check RTMP URL and stream status.")

                

            if self._is_live:

                # Start background thread to read frames continuously

                self._running = True

                self._stream_dead = False

                self._thread = threading.Thread(target=self._update, daemon=True)

                self._thread.start()

                

                # Wait for first frame (up to 5 seconds)

                _wait_start = time.time()

                while not self._ret and (time.time() - _wait_start) < 5.0:

                    time.sleep(0.05)

                

                if self._ret:

                    print(f"[VideoSource] OK Stream live and receiving frames")

                else:

                    print(f"[VideoSource] ! No frames yet within 5s - stream may be slow to start")



        print(f"[VideoSource] OK Video source opened: {self.source}")

        return self



    def _update(self):

        """Background thread continuously reads frames from live stream."""

        consecutive_fails = 0

        

        print(f"[Profiling] VideoSource RTMP connected to {self.source} at {time.time()}")

        while self._running:

            if not self.cap:

                time.sleep(0.01)

                continue

            

            try:

                ret, frame = self.cap.read()

                

                if ret and frame is not None:
                    if getattr(self, '_first_frame_read', False) is False:
                        self._first_frame_read = True
                        print(f"[Profiling] VideoSource first frame read from {self.source} at {time.time()}")

                    # Successfully read a frame — cache it

                    with self._frame_lock:

                        self._ret = True

                        self._frame = frame

                        self._last_frame_time = time.time()

                    

                    consecutive_fails = 0

                else:

                    # Frame read failed

                    consecutive_fails += 1

                    

                    if consecutive_fails > 120:  # ~12 seconds of failures = stream is really dead

                        print(f"[VideoSource._update] ✗ {consecutive_fails} failed reads (12+ sec) - stream dead")

                        self._stream_dead = True

                        self._running = False

                        break

                    

                    time.sleep(0.1)

            

            except Exception as e:

                print(f"[VideoSource._update] Exception: {e}")

                consecutive_fails += 1

                

                if consecutive_fails > 120:

                    self._stream_dead = True

                    self._running = False

                    break

                

                time.sleep(0.1)



    def read(self):

        """

        Read the latest frame for live streams.

        For live streams: returns the most recent frame cached by background thread.

        Never returns False just because there's no NEW frame - we cache and reuse frames.

        This prevents false disconnects on slight timing mismatches.

        """

        if self.cap is None:

            return False, None

        

        if self._is_live:

            # For live streams, check if stream is permanently dead

            if self._stream_dead:

                return False, None

            

            # Return the latest frame we have (even if not brand new)

            with self._frame_lock:

                ret = self._ret

                frame = self._frame

            

            # If we haven't gotten any frame yet, return False

            if not ret or frame is None:

                return False, None

            

            # Return the cached frame

            return True, frame

        else:

            # For files, read directly

            return self.cap.read()



    def release(self):

        self._running = False

        if self._thread:

            self._thread.join(timeout=1.0)

            

        if self.cap:

            self.cap.release()

            print("Video source released")



    def get_fps(self):

        if self.cap is None:

            return 0

        if self._is_gopro:

            return self.cap.get_fps()

        fps = self.cap.get(cv2.CAP_PROP_FPS)

        return fps if fps > 0 else 30.0



    def isOpened(self):

        if self.cap is None:

            return False

        return self.cap.isOpened()



    def __enter__(self):

        return self.open()



    def __exit__(self, *args):

        self.release()