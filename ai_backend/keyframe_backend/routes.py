from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
import glob
import os
import threading

from .keyframe import KeyframeStorage, KEYFRAME_STORAGE_DIR, MedicationEvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR, SOCIAL_STORAGE_DIR, ACTIVITY_STORAGE_DIR, ITEMS_STORAGE_DIR, ItemStorage
from db_config import get_client, get_db_name

router = APIRouter(prefix="/api/keyframes", tags=["Keyframes"])

# ── Serving keyframe images ─────────────────────────────────────────────────
#
# A keyframe is immutable. The id is a uuid minted when the frame is written,
# the JPEG behind it is never modified, and the only thing that ever happens to
# it afterwards is deletion by the retention sweeper. It was being served with
# "no-cache, no-store, must-revalidate", which tells the browser it may never
# keep a copy, so every poll of the dashboard re-downloaded every thumbnail it
# had already shown. The same handful of ids appear over and over in a single
# minute of the server log.
#
# Each of those re-downloads also ran up to four glob() calls with wildcards in
# two path segments, which walks every user directory and every date directory
# under four storage roots. That is a filesystem scan per thumbnail per poll,
# on a machine whose CPU is already saturated by inference, which is what made
# the dashboard feel slow to load frames.
IMAGE_CACHE_CONTROL = "public, max-age=31536000, immutable"

_PATH_CACHE: dict[str, str] = {}
_PATH_CACHE_LOCK = threading.Lock()
# Bounded so a long-running server cannot accumulate one entry per frame ever
# served. Well above any single dashboard page.
_PATH_CACHE_MAX = 4096

# ── Thumbnails ──────────────────────────────────────────────────────────────
#
# The memory page draws these frames 100 px wide. It was being sent the full
# 1280x720 capture for each one: measured, 196 frames is 16 MB and takes 19 s to
# load at a browser's six connections, 97 ms per frame. That is the whole of
# "the keyframes take too long", and it is the thing that would not survive more
# than one viewer, because the cost is bytes per page view.
#
# A width-bounded copy is written once, beside nothing else, and served
# thereafter. Thumbnails live in their own directory rather than next to the
# original because _resolve_frame globs by id and a sibling file would be found
# instead of the frame itself.
THUMB_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumb_cache")
# What a caller may ask for. An open integer would let anyone fill the disk with
# one file per width.
THUMB_WIDTHS = (160, 240, 480)


def _thumb_path(img_path: str, width: int) -> str | None:
    """A width-bounded JPEG for this frame, generated on first request.

    Returns None if the thumbnail cannot be made, so the caller falls back to
    the original rather than failing: a slow image beats a broken one.
    """
    if width not in THUMB_WIDTHS:
        return None
    try:
        import cv2
        st = os.stat(img_path)
        # The source mtime and size are in the name, so a frame replaced at the
        # same path can never be served from a stale thumbnail.
        key = f"{os.path.basename(img_path).rsplit('.', 1)[0]}.{int(st.st_mtime)}.{st.st_size}.w{width}.jpg"
        out = os.path.join(THUMB_CACHE_DIR, key)
        if os.path.exists(out):
            return out
        img = cv2.imread(img_path)
        if img is None:
            return None
        h, w = img.shape[:2]
        if w <= width:
            return img_path        # already small enough; no copy worth making
        small = cv2.resize(img, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)
        os.makedirs(THUMB_CACHE_DIR, exist_ok=True)
        # The temp name must still end in .jpg: OpenCV chooses its encoder from
        # the extension and refuses a ".tmp" outright, which is how this silently
        # served every full frame instead of a thumbnail.
        tmp = f"{out}.{os.getpid()}.tmp.jpg"
        if not cv2.imwrite(tmp, small, [int(cv2.IMWRITE_JPEG_QUALITY), 80]):
            return None
        os.replace(tmp, out)       # atomic, so a concurrent reader never sees a partial file
        return out
    except Exception as e:
        print(f"[Keyframes] thumbnail failed for {os.path.basename(img_path)}: {e}")
        return None


def _resolve_frame(frame_id: str, roots: list[str]) -> str | None:
    """Find the JPEG for a frame id, remembering where it was.

    Resolution is cached because the answer cannot change: an id maps to one
    file for as long as that file exists. A cached path is still checked on
    disk, so a frame removed by the retention sweeper is not served from a
    stale entry -- it falls through to a fresh search and then a 404.
    """
    with _PATH_CACHE_LOCK:
        hit = _PATH_CACHE.get(frame_id)
    if hit and os.path.exists(hit):
        return hit
    if hit:
        with _PATH_CACHE_LOCK:
            _PATH_CACHE.pop(frame_id, None)

    for root in roots:
        matches = glob.glob(os.path.join(root, "*", "*", f"{frame_id}.jpg"))
        if not matches:
            flat = os.path.join(root, f"{frame_id}.jpg")
            matches = [flat] if os.path.exists(flat) else []
        if matches:
            with _PATH_CACHE_LOCK:
                if len(_PATH_CACHE) >= _PATH_CACHE_MAX:
                    _PATH_CACHE.clear()
                _PATH_CACHE[frame_id] = matches[0]
            return matches[0]
    return None


def _serve_frame(img_path: str, request: Request | None = None, width: int | None = None):
    """Serve an immutable frame, answering 304 when the client already has it.

    The ETag was being sent but never read back: a revalidating client got a
    fresh 200 and the whole JPEG again, so the header promised a cheap
    revalidation the route did not implement. Measured, a 95 KB frame costs
    10 ms and a full gallery re-render paid for every byte a second time.
    """
    # Resolve the thumbnail BEFORE the ETag, so the tag describes the bytes
    # actually sent. Tagging the original and sending a thumbnail would let a
    # client cache the small one under the full one's identity.
    if width:
        thumb = _thumb_path(img_path, width)
        if thumb:
            img_path = thumb
    try:
        st = os.stat(img_path)
        etag = f'"{int(st.st_mtime)}-{st.st_size}"'
    except OSError:
        etag = None
    headers = {"Cache-Control": IMAGE_CACHE_CONTROL}
    if etag:
        headers["ETag"] = etag
        # If-None-Match may carry a list, and a proxy may weaken the tag with a
        # W/ prefix, so compare against the members rather than the raw string.
        inm = request.headers.get("if-none-match") if request is not None else None
        if inm:
            seen = {t.strip().removeprefix("W/") for t in inm.split(",")}
            if etag in seen or "*" in seen:
                return Response(status_code=304, headers=headers)
    return FileResponse(img_path, media_type="image/jpeg", headers=headers)

# Singleton storage instances
_storage = None
_evidence_storage = None
_social_storage = None
_item_storage = None


def _get_storage():
    global _storage
    if _storage is None:
        _storage = KeyframeStorage(KEYFRAME_STORAGE_DIR)
    return _storage


def _get_evidence_storage():
    global _evidence_storage
    if _evidence_storage is None:
        _evidence_storage = MedicationEvidenceStorage(MEDICATION_EVIDENCE_STORAGE_DIR)
    return _evidence_storage


def _get_social_storage():
    global _social_storage
    if _social_storage is None:
        from .keyframe import SocialInteractionStorage
        _social_storage = SocialInteractionStorage(SOCIAL_STORAGE_DIR)
    return _social_storage


def _get_item_storage():
    global _item_storage
    if _item_storage is None:
        _item_storage = ItemStorage(ITEMS_STORAGE_DIR)
    return _item_storage


def _parse_timestamp(ts):
    if not ts: return 0.0
    if isinstance(ts, (int, float)): return float(ts)
    if isinstance(ts, str):
        try:
            # Simple fallback for iso strings, otherwise just string sort works if we convert everything to string
            # But the best way is to convert to float. We can use datetime.fromisoformat
            from datetime import datetime
            return datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp()
        except:
            return 0.0
    return 0.0

@router.get("")
async def list_keyframes(limit: int = 50, user_id: str = ""):
    """
    List stored keyframes with metadata.
    Auto-cleaned after 72 hours.
    """
    storage = _get_storage()
    keyframes = storage.list_keyframes(user_id=user_id or None, limit=limit)
    
    if keyframes:
        try:
            from pymongo import MongoClient
            client = get_client()
            db = client[get_db_name()]
            k_ids = [k.get("keyframe_id") for k in keyframes if k.get("keyframe_id")]
            # Fetch ALL matching eventlogs to get _id and is_flagged
            events = db.eventlogs.find({"keyframe_id": {"$in": k_ids}}, {"keyframe_id": 1, "_id": 1, "is_flagged": 1})
            
            event_map = {}
            for ev in events:
                if ev.get("keyframe_id"):
                    event_map[ev.get("keyframe_id")] = {
                        "_id": str(ev.get("_id")),
                        "is_flagged": ev.get("is_flagged", False)
                    }
                    
            for k in keyframes:
                kid = k.get("keyframe_id")
                if kid in event_map:
                    k["is_flagged"] = event_map[kid]["is_flagged"]
                    k["_id"] = event_map[kid]["_id"]
                else:
                    k["is_flagged"] = False
                
        except Exception as ex:
            print(f"Error fetching flags for keyframes: {ex}")
            for k in keyframes:
                if "is_flagged" not in k: k["is_flagged"] = False
                
    return keyframes


@router.get("/{keyframe_id}/image")
async def get_keyframe_image(keyframe_id: str, request: Request, w: int | None = None):
    """
    Serve a keyframe image by its ID for visual display in the caregiver dashboard.

    `w` asks for a width-bounded copy, for lists that draw these small. Anything
    not in THUMB_WIDTHS is ignored and the full frame is sent.
    """
    img_path = _resolve_frame(keyframe_id, [
        KEYFRAME_STORAGE_DIR, SOCIAL_STORAGE_DIR, ACTIVITY_STORAGE_DIR, ITEMS_STORAGE_DIR,
    ])
    if not img_path:
        raise HTTPException(status_code=404, detail="Keyframe image not found")
    return _serve_frame(img_path, request, w)


@router.get("/sync")
async def sync_keyframes(user_id: str):
    """
    Fetch all keyframes for a user as base64 images so the client can save them locally.
    """
    import base64
    import glob
    storage = _get_storage()
    keyframes = storage.list_keyframes(user_id=user_id, limit=50) # fetch 50 at a time
    
    for kf in keyframes:
        img_path = None
        matches = glob.glob(os.path.join(KEYFRAME_STORAGE_DIR, "*", "*", f"{kf['keyframe_id']}.jpg"))
        if not matches:
            matches = glob.glob(os.path.join(SOCIAL_STORAGE_DIR, "*", "*", f"{kf['keyframe_id']}.jpg"))
            
        if matches:
            img_path = matches[0]
        else:
            legacy = os.path.join(KEYFRAME_STORAGE_DIR, f"{kf['keyframe_id']}.jpg")
            if os.path.exists(legacy):
                img_path = legacy
            else:
                legacy_social = os.path.join(SOCIAL_STORAGE_DIR, f"{kf['keyframe_id']}.jpg")
                if os.path.exists(legacy_social):
                    img_path = legacy_social
                
        if img_path and os.path.exists(img_path):
            with open(img_path, "rb") as f:
                kf["base64_image"] = base64.b64encode(f.read()).decode("utf-8")
                
    return keyframes

@router.post("/sync/confirm")
async def confirm_sync(body: dict):
    """
    (Deprecated) Used to delete keyframes after sync. Now disabled to allow cross-device viewing.
    """
    return {"deleted": 0, "status": "sync_disabled_to_support_cloud"}

# ── Medicine Evidence Frames ─────────────────────────────────────────────

@router.get("/medication_frames")
async def list_medication_frames(limit: int = 100, user_id: str = ""):
    """
    List stored medicine evidence frames (Phase 1/2/3 from successful detections).
    Sorted newest-first. Auto-cleaned after 72 hours.
    """
    storage = _get_evidence_storage()
    evidence = storage.list_evidence(user_id=user_id or None, limit=limit)
    
    if evidence:
        try:
            from pymongo import MongoClient
            client = get_client()
            db = client[get_db_name()]
            # ID is sometimes stored as 'evidence_id' or 'id' in the json, or 'keyframe_id' in eventlogs
            e_ids = [e.get("evidence_id") for e in evidence if e.get("evidence_id")]
            events = db.eventlogs.find({"keyframe_id": {"$in": e_ids}}, {"keyframe_id": 1, "_id": 1, "is_flagged": 1})
            
            event_map = {}
            for ev in events:
                if ev.get("keyframe_id"):
                    event_map[ev.get("keyframe_id")] = {
                        "_id": str(ev.get("_id")),
                        "is_flagged": ev.get("is_flagged", False)
                    }
                    
            for e in evidence:
                eid = e.get("evidence_id")
                if eid in event_map:
                    e["is_flagged"] = event_map[eid]["is_flagged"]
                    e["_id"] = event_map[eid]["_id"]
                else:
                    e["is_flagged"] = False
                
        except Exception as ex:
            print(f"Error fetching flags for evidence: {ex}")
            for e in evidence:
                if "is_flagged" not in e: e["is_flagged"] = False
                
    return evidence


@router.get("/medication_frames/{evidence_id}/owner")
async def get_medication_frame_owner(evidence_id: str):
    """Who a medicine evidence frame belongs to.

    The Node gateway authorises these images by resolving the frame's owner, and
    it can only look in MongoDB. A medicine phase frame is referenced by no
    event row: its owner lives in the json sidecar beside the image, written by
    MedicationEvidenceStorage. So of the six frames from one intake, only the
    one the medication_log happens to point at could be authorised, and the
    other five were refused as unowned. This is how the gateway asks.

    Returns the owner only. Nothing about the medicine, the dose or the
    detection, because authorising an image needs none of it.
    """
    storage = _get_evidence_storage()
    meta = storage.load_metadata(evidence_id) or {}
    user_id = meta.get("user_id")
    if not user_id:
        raise HTTPException(status_code=404, detail="Evidence frame not found")
    return {"user_id": str(user_id)}


@router.get("/medication_frames/{evidence_id}/image")
async def get_medication_frame_image(evidence_id: str, request: Request):
    """
    Serve an evidence frame image by its ID.
    """
    img_path = _resolve_frame(evidence_id, [MEDICATION_EVIDENCE_STORAGE_DIR])
    if not img_path:
        raise HTTPException(status_code=404, detail="Evidence frame not found")
    return _serve_frame(img_path, request)
