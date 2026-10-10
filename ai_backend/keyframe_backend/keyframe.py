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

# ── Event-aligned capture ───────────────────────────────────────────────────
#
# Disk saving used to be triggered by MOTION alone: a frame-to-frame difference
# above scene_motion_threshold armed a burst, and the sharpest frame of the next
# 15 won. Motion is a proxy for "the camera moved", which is close to useless as
# a proxy for "something worth remembering happened" -- and it is actively
# inverted for the two events this system exists to record. Swallowing a pill is
# a small, slow hand movement. Sitting with a phone is almost perfectly still.
# In a real 7-minute recording that gate stored 8 frames, none of the wearer's
# medication, and nothing of the room they were actually standing in.
#
# So the decision of WHEN to save is now driven by the detectors, and only the
# choice of WHICH frame stays with sharpness. Every processed frame enters a
# short rolling window; when a detector reports an event, the sharpest frame in
# that window is persisted and tagged with the event. Because the window holds
# history, the frame that gets kept can PRE-DATE the detector's confirmation --
# which is what we want, since a pill is clearest a moment before the sequence
# completes.
# FE-3 asks for 5-10 s around the event; 3.0 sat under that floor. At
# CAPTURE_FPS=5 this is 30 frames of look-back. Raising it alone is not
# enough -- EVENT_WINDOW_MAX_BYTES trims the window from the oldest end,
# so the byte budget below has to admit the full span or the seconds here
# are silently reduced.
EVENT_WINDOW_SECONDS = float(os.environ.get("EVENT_WINDOW_SECONDS", 6.0))

# Per-event-kind cooldown. Separate per kind so a chatty detector cannot starve
# a quiet one: a stream of activity frames must never crowd out the one
# medication frame in the same minute.
EVENT_COOLDOWN_SECONDS = {
    "medication": float(os.environ.get("EVENT_COOLDOWN_MEDICATION", 4.0)),
    "social": float(os.environ.get("EVENT_COOLDOWN_SOCIAL", 20.0)),
    "activity": float(os.environ.get("EVENT_COOLDOWN_ACTIVITY", 15.0)),
    "item": float(os.environ.get("EVENT_COOLDOWN_ITEM", 20.0)),
    "scene_change": float(os.environ.get("SCENE_COOLDOWN_SECONDS", 8.0)),
    "coverage": float(os.environ.get("EVENT_COOLDOWN_COVERAGE", 120.0)),
}

# Motion needed to arm the old opportunistic scene capture. Still useful for
# catching room changes the detectors say nothing about, just no longer the only
# way a frame reaches disk.
SCENE_MOTION_THRESHOLD = float(os.environ.get("SCENE_MOTION_THRESHOLD", 15.0))

# Guarantee a frame at least this often while the camera is running, whatever
# the detectors and the motion score say. Without it a motionless wearer
# produces NO frames at all, so a caregiver who is told "hasn't moved for three
# hours" opens the memory view and finds nothing to look at -- the one case
# where a picture matters most is the one case that had none.
COVERAGE_SECONDS = float(os.environ.get("COVERAGE_SECONDS", 120.0))

# Events accept a softer sharpness floor than opportunistic captures: a slightly
# soft frame of a dose being taken is worth far more than no evidence at all.
# Medication bypasses the floor entirely (see capture_event).
EVENT_BLUR_RATIO = float(os.environ.get("EVENT_BLUR_RATIO", 0.6))

# Hard ceiling on what the rolling window may hold, in bytes. The window is
# sized in SECONDS, which is right for behaviour and dangerous for memory: 3s at
# 10 FPS is 27 MB of 640x480 frames but 186 MB at 1080p. Frames are dropped from
# the oldest end once the budget is hit, so the window shortens on a
# high-resolution camera rather than exhausting memory on a long session.
# 64 MB held only 24 of the 30 frames EVENT_WINDOW_SECONDS now asks for at
# 720p (2.64 MB a frame), which capped the real window at 4.8 s -- under
# the FE-3 floor, with nothing logged to say so. 96 MB covers the full 6 s
# up to ~3.2 MB a frame. Above that (1080p is 6.2 MB) the window still
# shortens, which is the intended trade: bounded memory over a long window.
EVENT_WINDOW_MAX_BYTES = int(os.environ.get("EVENT_WINDOW_MAX_BYTES", 96 * 1024 * 1024))

# A frame this dark holds no evidence and must not be saved, whatever triggered
# it. Sharpness does not catch this: a nearly black frame can have perfectly
# good Laplacian variance from sensor noise, and two frames in the 25 Sep
# recording were stored at mean luminance 4.9 and 7.8, with 99% and 95% of
# their pixels below 40. They show nothing. They also cost more than disk: every
# saved frame is fed to the room classifier, where a frame that recognises
# nothing keeps an open session coasting instead of closing it, so blank frames
# actively stretch a session over rooms the wearer had already left.
MIN_FRAME_LUMINANCE = float(os.environ.get("MIN_FRAME_LUMINANCE", 15.0))


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

    # Only the CAPTURE store feeds the item indexer.
    #
    # items_storage, activities_storage and social_storage hold frames the
    # pipeline wrote ABOUT a frame it had already indexed, and they inherit this
    # save(). So storing a put-down handed that very picture back to the indexer,
    # which recognised the same phone in the same box and stored another copy,
    # and again: 01:22:52 was written three times, 8s and 51s apart, with three
    # keyframes of one identical image (md5 754351cb, all three naming source
    # frame 285be1ce). The capture timestamp travels in the metadata, so every
    # lap was filed at the original moment and the feed showed one put-down as
    # three memories.
    feeds_item_indexer = True

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

        

    def save(self, keyframe_id, frame, metadata, index_frame=None):
        """Write `frame` to disk and hand `index_frame` to the item indexer.

        They differ only under Privacy Mode's blur, where the frame that is
        KEPT must be unreadable but the frame that is ANALYSED must not be.
        Blurring both meant blur silently switched off every detector: a
        pixelated frame yields no objects, so for the ten minutes one wearer
        had it on, nothing was recognised, no belonging was tracked and no room
        was named. Privacy was supposed to cost recognisable pictures, not the
        whole system.
        """

        uid = str(metadata.get("user_id", "unknown"))

        today = datetime.now().strftime("%Y-%m-%d")

        user_dir = os.path.join(self.storage_dir, uid, today)

        os.makedirs(user_dir, exist_ok=True)

        img_path  = os.path.join(user_dir, f"{keyframe_id}.jpg")

        meta_path = os.path.join(user_dir, f"{keyframe_id}.json")



        # ── Privacy blur, applied where the file is actually written ────────
        #
        # Here rather than at each caller, because there are five stores and
        # four separate face-crop writes, and one of them WILL be forgotten.
        # The frame handed to the item indexer stays sharp (index_frame), so
        # blur costs recognisable pictures and not the detectors: blurring both
        # had quietly switched off every detector for as long as it was on.
        uid_for_privacy = str(metadata.get("user_id") or "")
        if uid_for_privacy and not metadata.get("privacy_blurred"):
            try:
                from ai.privacy import state as _pstate, blur_frame
                if _pstate(uid_for_privacy).get("blur"):
                    blurred = blur_frame(frame)
                    if blurred is None:
                        print(f"[KeyframeStorage.save] refusing to write {keyframe_id}: "
                              f"privacy blur failed and a readable frame must not be kept")
                        return
                    frame = blurred
                    metadata = {**metadata, "privacy_blurred": True}
            except Exception as e:
                print(f"[KeyframeStorage.save] privacy check failed, not writing: {e}")
                return

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
        if self.feeds_item_indexer:
            try:
                from ai.item_indexer import DailyItemIndexer
                DailyItemIndexer.get_instance().enqueue_keyframe(
                    keyframe_id,
                    frame if index_frame is None else index_frame,
                    metadata)
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
                    stem = os.path.basename(meta_path).replace(".json", "")
                    meta["keyframe_id"] = stem
                    # Every row needs an `id` and a `timestamp`: that is what
                    # the clients ask for the image by, and what they sort on.
                    # A face crop's sidecar carries neither -- it is written
                    # with user_id, source_frame, type, file and saved_at -- so
                    # those rows reached the audit page with id undefined, the
                    # page requested /keyframes/undefined/image, and they drew
                    # as blanks beside perfectly good images.
                    meta.setdefault("id", stem)
                    meta["date"] = date_str
                    if "timestamp" in meta and "saved_at" not in meta:
                        meta["saved_at"] = meta["timestamp"]
                    if "timestamp" not in meta and "saved_at" in meta:
                        meta["timestamp"] = meta["saved_at"]

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
    feeds_item_indexer = False

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
    feeds_item_indexer = False

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
    feeds_item_indexer = False

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
        # Kept as instance attributes so they stay tunable per extractor; the
        # cooldown itself is enforced in capture_event, from
        # EVENT_COOLDOWN_SECONDS, rather than by a second timer here.
        self.scene_cooldown_seconds = EVENT_COOLDOWN_SECONDS["scene_change"]
        self.scene_motion_threshold = SCENE_MOTION_THRESHOLD
        self.on_scene_saved = None

        # Rolling window of recent frames for event-aligned capture. Every
        # processed frame lands here regardless of motion, so a detector firing
        # on a still scene still has sharp frames to choose from. Sized in
        # SECONDS so it holds the same span of history at any capture rate.
        self._recent = deque(maxlen=max(4, int(EVENT_WINDOW_SECONDS * target_fps)))
        self._recent_lock = threading.Lock()

        # Last disk save per event kind, for the per-kind cooldowns.
        self._last_event_save = {}
        self._last_any_save = 0.0
        self.on_event_saved = None

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



    def capture_event(self, kind, label=None, confidence=None, extra=None,
                      force=False):
        """Persist the sharpest recent frame because `kind` just happened.

        This is the event-aligned half of keyframe storage: the detectors decide
        WHEN, sharpness decides WHICH. The rolling window holds history, so the
        frame chosen may pre-date the call -- a pill is clearest a moment before
        the three-phase sequence finishes confirming it.

        Returns the saved keyframe id, or None when nothing was saved (cooldown
        still running, no frames yet, or every candidate too blurred).
        """
        if not (self.save_locally and self.storage):
            return None

        # ── The privacy gate (Module A FE-4/FE-5) ───────────────────────────
        # 'paused' and the automatic rules stop a frame existing at all.
        # 'blur' lets it exist, unreadable, so the day still has a record.
        _blur = False
        _uid = getattr(self, "user_id", "")
        if _uid:
            try:
                from ai.privacy import state as _privacy_state
                st = _privacy_state(str(_uid))
                if not st["capture"]:
                    # Before the cooldown slot is claimed, so a refused frame
                    # does not consume the allowance of the one after it: the
                    # first frame once privacy ends would otherwise be skipped.
                    print(f"[KeyframeExtractor] {kind} not captured: {st['reason']}")
                    return None
                _blur = st["blur"]
            except Exception as e:
                # Capture carries on. A privacy check that takes the camera
                # down whenever Mongo hiccups is its own harm; see ai/privacy.py.
                print(f"[KeyframeExtractor] privacy check skipped: {e}")

        now = time.time()
        cooldown = EVENT_COOLDOWN_SECONDS.get(kind, 10.0)

        # Claim the cooldown slot and read the window under one lock. This is
        # called from the capture loop AND from each detector's own thread, so a
        # plain check-then-set lets two callers both pass the same cooldown and
        # save duplicate frames for one event.
        with self._recent_lock:
            if not force and (now - self._last_event_save.get(kind, 0.0)) < cooldown:
                return None
            candidates = list(self._recent)
            if not candidates:
                return None
            # ONE image per moment, shared by every event that describes it.
            #
            # A real recording wrote the same instant four times over, as
            # scene_change, medication, social and activity, every copy at blur
            # 237.2. Each was a separate file and a separate Tier-2 job, which
            # is what kept the indexing queue tens of frames deep, and each
            # counted again towards the open session's frame total.
            #
            # Picking a different unused frame per event does not fix that: four
            # near-identical images of one second is still four of everything.
            # So while any frame in the window is already on disk, later events
            # point at it instead of writing again. The window is three seconds
            # long, so a genuinely new moment always gets its own image.
            saved = [c for c in candidates if c.get("saved")]
            already_saved = bool(saved)
            if already_saved:
                best = max(saved, key=lambda c: c["blur_score"])
            else:
                best = max(candidates, key=lambda c: c["blur_score"])
                best["saved"] = True
            prev_kind_save = self._last_event_save.get(kind, 0.0)
            prev_any_save = self._last_any_save
            self._last_event_save[kind] = now
            self._last_any_save = now

        def _give_back():
            with self._recent_lock:
                self._last_event_save[kind] = prev_kind_save
                self._last_any_save = prev_any_save
                if not already_saved:
                    best["saved"] = False

        # Blank frames are rejected for EVERY kind, including medication. A
        # blurred dose is still evidence; a black one is not evidence of
        # anything, so there is nothing to preserve by keeping it.
        try:
            luminance = float(cv2.cvtColor(best["frame"], cv2.COLOR_BGR2GRAY).mean())
        except Exception:
            luminance = MIN_FRAME_LUMINANCE      # unreadable: do not reject on it
        if luminance < MIN_FRAME_LUMINANCE:
            print(f"[KeyframeExtractor] {kind} capture rejected as blank: "
                  f"luminance {luminance:.1f} < {MIN_FRAME_LUMINANCE}")
            _give_back()
            return None

        # Medication is the one event we never drop for softness: a blurred
        # record of a dose is evidence, and no record is a missed dose.
        if kind != "medication":
            floor = self.blur_threshold * (EVENT_BLUR_RATIO if kind != "coverage" else 1.0)
            if best["blur_score"] < floor:
                print(f"[KeyframeExtractor] {kind} capture rejected on blur: "
                      f"{best['blur_score']:.1f} < {floor:.1f}")
                # Give the claim back. Nothing was written, so this must not
                # count as a save -- otherwise a persistently soft stream keeps
                # resetting the coverage floor and never produces any frame at
                # all, which is the exact failure the floor exists to prevent.
                _give_back()
                return None

        # Already on disk from an earlier event. The image is the same one, so
        # the right thing is to point this event at it rather than write a
        # second copy and index it again.
        if already_saved:
            print(f"[KeyframeExtractor] {kind} reuses frame "
                  f"{best['keyframe_id'][:8]}, already saved")
            return best["keyframe_id"]

        metadata = {
            "id": best["keyframe_id"],
            "timestamp": best["timestamp"],
            "motion_score": round(float(best["motion_score"]), 2),
            "blur_score": round(float(best["blur_score"]), 2),
            "width": best["frame"].shape[1],
            "height": best["frame"].shape[0],
            "user_id": getattr(self, "user_id", ""),
            "event_type": kind,
            "selected_from": len(candidates),
        }
        if label:
            metadata["label"] = label
        if confidence is not None:
            metadata["confidence"] = round(float(confidence), 3)
        if extra:
            metadata.update(extra)

        print(f"[KeyframeExtractor] {kind} frame saved (blur "
              f"{best['blur_score']:.1f}, best of {len(candidates)})"
              + (f": {label}" if label else ""))

        # Blurred HERE, once, so every copy downstream is blurred: the file on
        # disk, the frame handed to the item indexer, and therefore any item or
        # session frame derived from it. Blurring only at the point of writing
        # the image would have left the indexer storing sharp crops of the same
        # moment in items_storage.
        #
        # A new array, never the one in the ring buffer: that frame is shared
        # with the other events of this moment and with the detectors.
        # Blurring happens in KeyframeStorage.save, which is the one place a
        # frame becomes a file. The sharp frame goes to the indexer either way.
        frame_sharp = best["frame"]
        frame_out = frame_sharp

        threading.Thread(
            target=self._save_event_async,
            args=(best["keyframe_id"], frame_out, metadata, kind, frame_sharp),
            daemon=True).start()
        return best["keyframe_id"]

    def maybe_capture_coverage(self):
        """Save a frame if nothing has reached disk for COVERAGE_SECONDS.

        Called from the pipeline's liveness heartbeat, so it runs whether or not
        anybody is moving. This is what gives an inactivity stretch something to
        show; a still wearer previously produced an empty memory view.
        """
        if (time.time() - self._last_any_save) < COVERAGE_SECONDS:
            return None
        return self.capture_event(
            "coverage", label="Routine check", extra={"reason": "coverage_floor"})

    def _save_event_async(self, keyframe_id, frame, metadata, kind, index_frame=None):
        try:
            # `frame` is what is kept, `index_frame` is what is analysed. Under
            # blur they differ; otherwise they are the same array.
            self.storage.save(keyframe_id, frame, metadata, index_frame=index_frame)
            if self.on_event_saved:
                self.on_event_saved(keyframe_id, kind, metadata)
            # Event frames are still frames: hand them to the same Tier-2 path
            # that indexes items and tracks rooms, so a medication or coverage
            # frame contributes its objects to the scene tracker too. Starving
            # that tracker of everything except motion spikes is exactly why the
            # kitchen was never recognised.
            #
            # The KIND travels with it. Without it every event frame was written
            # to the database as a raw motion burst, and memory search hides
            # those -- so a coverage frame, whose entire purpose is to give a
            # still stretch something to show, was filed under the one label
            # guaranteed to keep it hidden.
            if self.on_scene_saved:
                motion = metadata.get("motion_score", 0.0)
                try:
                    # The whole metadata, not just the kind: it carries the
                    # capture timestamp too, and without that the memory is
                    # filed when the worker got round to it rather than when
                    # the frame was taken.
                    self.on_scene_saved(keyframe_id, motion, metadata)
                except TypeError:
                    # An older two-argument callback. Falling back matters:
                    # this same call is what hands the frame to Tier-2, so
                    # letting the TypeError escape would stop item indexing and
                    # room tracking for every event frame, silently.
                    self.on_scene_saved(keyframe_id, motion)
        except Exception as e:
            print(f"[KeyframeExtractor] ERROR saving {kind} {keyframe_id}: {e}")



    def flush_remaining(self):
        """Persist the last of the rolling window when the stream stops.

        Forced past the cooldown: this is the final frame of the session and
        there is no later opportunity to save it.
        """
        return self.capture_event(
            "scene_change", extra={"reason": "stream_stopped"}, force=True)

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

        # Exposed so the pipeline's liveness heartbeat can report how much
        # movement there was, including when there was none. Without this the
        # only record of motion is a scene_change, which is never written while
        # somebody sits still -- so "camera on, person motionless" looked
        # exactly like "camera off".
        self.last_motion_score = motion_score
        self.peak_motion_since_heartbeat = max(
            getattr(self, "peak_motion_since_heartbeat", 0.0), motion_score)

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


        # 1. Rolling window for event-aligned capture. EVERY processed frame
        # enters it, whatever the motion score, so that when a detector fires on
        # a still scene there is sharp history to choose from. This is the pool
        # capture_event() selects out of.
        with self._recent_lock:
            self._recent.append({
                'frame': frame.copy(),
                'blur_score': blur_score,
                'motion_score': motion_score,
                'timestamp': timestamp,
                'keyframe_id': keyframe_id,
                'nbytes': int(getattr(frame, 'nbytes', 0)),
            })
            # Shorten the window rather than exhaust memory on a
            # high-resolution camera (see EVENT_WINDOW_MAX_BYTES).
            total = sum(c.get('nbytes', 0) for c in self._recent)
            while len(self._recent) > 2 and total > EVENT_WINDOW_MAX_BYTES:
                total -= self._recent.popleft().get('nbytes', 0)

        # 2. Opportunistic scene capture on motion. Now just one more trigger
        # into capture_event() rather than its own burst-and-cooldown machine:
        # the old version collected a fixed 15 frames, which is 1.5s at 10 FPS
        # but 3s at 5 FPS, so the settle time silently changed with the rate. It
        # also kept its own copy of every frame during a burst, duplicating the
        # window that now exists anyway.
        if motion_score > self.scene_motion_threshold:
            self.capture_event("scene_change")



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