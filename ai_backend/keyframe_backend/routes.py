from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
import glob
import json
import os
import re
import shutil
import threading
import time

from .keyframe import KEYFRAME_TTL_HOURS, KeyframeStorage, KEYFRAME_STORAGE_DIR, MedicationEvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR, SOCIAL_STORAGE_DIR, ACTIVITY_STORAGE_DIR, ITEMS_STORAGE_DIR, ItemStorage
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
# Defined in keyframe.py, where retention can also reach it: a second copy of
# this path here is how the sweeper came to delete frames and leave renderings.
from .keyframe import THUMB_CACHE_DIR
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

@router.delete("/medication_frames")
async def delete_medication_frames(user_id: str = "", medication_id: str = "",
                                   since: str = "", until: str = ""):
    """Destroy the evidence frames for one medication, for one wearer.

    The per-id delete cannot do this. An intake event does not always carry a
    keyframe_id -- the one the wearer rejected on 14 Oct carried none -- and
    rejectIntakeEventLog deletes by exactly that field, so the Phase 2 and
    Phase 3 pictures survived being told the dose never happened. Meanwhile
    list_medication_frames reads the store directly and never looks at
    eventlogs, so they stayed visible in the audit.

    Evidence sidecars always carry user_id and medication_id, so that is what
    this matches on: the medication the frames claim to be evidence OF.

    `since` and `until` are optional ISO timestamps bounding detected_at, so
    rejecting one dose cannot take out the frames of a different dose of the
    same medicine on another day. Both are compared as strings, which is safe
    because detected_at is written in ISO 8601 with a fixed offset.

    Declared BEFORE /{keyframe_id} so the literal path wins the route match;
    FastAPI resolves in declaration order and would otherwise read
    "medication_frames" as a keyframe id.
    """
    if not user_id or not medication_id:
        raise HTTPException(status_code=400,
                            detail="user_id and medication_id are required")

    removed, kept = [], 0
    for meta_path in glob.glob(os.path.join(
            MEDICATION_EVIDENCE_STORAGE_DIR, "*", "*", "*.json")):
        try:
            with open(meta_path, "r", encoding="utf-8") as fh:
                meta = json.load(fh)
        except Exception:
            continue
        if str(meta.get("user_id", "")) != str(user_id):
            continue
        if str(meta.get("medication_id", "")) != str(medication_id):
            kept += 1
            continue
        when = str(meta.get("detected_at", ""))
        if since and when and when < since:
            kept += 1
            continue
        if until and when and when > until:
            kept += 1
            continue
        stem = meta_path[:-len(".json")]
        for path in (stem + ".json", stem + ".jpg", stem + ".jpeg", stem + ".png"):
            if os.path.exists(path):
                try:
                    os.remove(path)
                    removed.append(os.path.basename(path))
                except OSError:
                    pass
        base = os.path.basename(stem)
        for t in glob.glob(os.path.join(THUMB_CACHE_DIR, base + "*")):
            try:
                os.remove(t)
                removed.append(os.path.basename(t))
            except OSError:
                pass

    print(f"[Keyframes] removed {len(removed)} medication evidence file(s) for "
          f"medication {medication_id}; {kept} other frame(s) left alone")
    return {"deleted": len(removed), "files": removed, "kept": kept}


@router.delete("/{keyframe_id}")
async def delete_keyframe(keyframe_id: str, user_id: str = ""):
    """Destroy one frame across every store (and its thumbnail).

    For a sighting the wearer has said did not happen. Rejecting a medication
    intake marked the event row and left the photograph on disk, so a frame of
    somebody lifting a laptop stayed in the Keyframe Audit, filed as evidence
    of a dose, after they had answered "no". The row stays and stays rejected,
    which is the audit trail; what goes is the picture, exactly as the privacy
    purge does it.

    `user_id` is required and is checked against the sidecar, so an id alone
    cannot delete another wearer's frame.
    """
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if not re.fullmatch(r"[A-Za-z0-9_-]{4,64}", keyframe_id or ""):
        # The id goes into a glob; anything that could climb out of the store
        # is refused rather than sanitised.
        raise HTTPException(status_code=400, detail="bad keyframe id")

    roots = [KEYFRAME_STORAGE_DIR, MEDICATION_EVIDENCE_STORAGE_DIR,
             SOCIAL_STORAGE_DIR, ACTIVITY_STORAGE_DIR, ITEMS_STORAGE_DIR]
    removed = []
    for root in roots:
        for path in glob.glob(os.path.join(root, "*", "*", keyframe_id + ".*")):
            meta = path[:path.rfind(".")] + ".json"
            owner = ""
            if os.path.exists(meta):
                try:
                    with open(meta, "r", encoding="utf-8") as fh:
                        owner = str(json.load(fh).get("user_id", ""))
                except Exception:
                    owner = ""
            if owner and owner != str(user_id):
                continue
            try:
                os.remove(path)
                removed.append(os.path.basename(path))
            except OSError:
                pass
    # The rendered thumbnail too, or the audit page keeps showing it.
    for t in glob.glob(os.path.join(THUMB_CACHE_DIR, keyframe_id + "*")):
        try:
            os.remove(t)
            removed.append(os.path.basename(t))
        except OSError:
            pass
    print(f"[Keyframes] deleted {len(removed)} file(s) for {keyframe_id[:8]} "
          f"at the wearer's request")
    return {"deleted": len(removed), "files": removed}


@router.get("/storage")
async def storage_usage(user_id: str = ""):
    """What this device is actually holding, per store (Module 6 FE-4).

    The AI backend is the only part of the system that can answer this: the
    frames live on ITS disk, and the gateway has never had a way to see them.
    Reported per store rather than as one number, because the five stores
    expire on different clocks and a reader deciding what to clean up needs to
    know which pile is which.

    `user_id` narrows it to one wearer. Left out, it reports the whole device,
    which is what an operator wants and what a wearer must never be shown.
    """
    stores = {
        "keyframes": KEYFRAME_STORAGE_DIR,
        "medication_evidence": MEDICATION_EVIDENCE_STORAGE_DIR,
        "social": SOCIAL_STORAGE_DIR,
        "activities": ACTIVITY_STORAGE_DIR,
        "items": ITEMS_STORAGE_DIR,
    }
    now = time.time()
    out, total_bytes, total_files, oldest = {}, 0, 0, None
    for name, root in stores.items():
        base = os.path.join(root, user_id) if user_id else root
        files = 0
        nbytes = 0
        store_oldest = None
        for dirpath, _dirs, names in os.walk(base):
            for fn in names:
                if not fn.lower().endswith((".jpg", ".jpeg", ".png", ".json")):
                    continue
                fp = os.path.join(dirpath, fn)
                try:
                    st = os.stat(fp)
                except OSError:
                    continue
                files += 1
                nbytes += st.st_size
                if store_oldest is None or st.st_mtime < store_oldest:
                    store_oldest = st.st_mtime
        out[name] = {
            "files": files,
            "bytes": nbytes,
            "oldest_hours": round((now - store_oldest) / 3600.0, 1) if store_oldest else None,
        }
        total_bytes += nbytes
        total_files += files
        if store_oldest and (oldest is None or store_oldest < oldest):
            oldest = store_oldest

    # Free space on the volume the frames live on, so "is this a problem?" can
    # be answered rather than guessed at from a number of megabytes.
    try:
        usage = shutil.disk_usage(KEYFRAME_STORAGE_DIR)
        disk = {"free_bytes": usage.free, "total_bytes": usage.total}
    except Exception:
        disk = None

    return {
        "stores": out,
        "total_files": total_files,
        "total_bytes": total_bytes,
        "oldest_hours": round((now - oldest) / 3600.0, 1) if oldest else None,
        "retention_hours": KEYFRAME_TTL_HOURS,
        "disk": disk,
        "scope": user_id or "all users",
    }


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


@router.get("/{keyframe_id}/owner")
async def get_keyframe_owner(keyframe_id: str):
    """Who an ordinary keyframe belongs to.

    The same gap the medication route above was built for, one store over. The
    Node gateway authorises an image by resolving its owner and can only look
    in MongoDB, but not every saved frame has an event row pointing at it: a
    capture taken for a medication or social moment is written to
    keyframe_storage whether or not that moment ever produced a row, and its
    owner then exists only in the json sidecar.

    Measured on one account: 10 of the 90 frames the audit page lists came back
    404 and drew as blanks, every one of them a medication or social capture
    with an image on disk that the gateway could not establish an owner for.

    Returns the owner only. Nothing about what the frame shows, because
    authorising an image needs none of it.
    """
    img_path = _resolve_frame(keyframe_id, [
        KEYFRAME_STORAGE_DIR, SOCIAL_STORAGE_DIR, ACTIVITY_STORAGE_DIR, ITEMS_STORAGE_DIR,
    ])
    if not img_path:
        raise HTTPException(status_code=404, detail="Keyframe not found")
    meta_path = os.path.splitext(img_path)[0] + ".json"
    user_id = None
    try:
        with open(meta_path, "r") as f:
            user_id = (json.load(f) or {}).get("user_id")
    except Exception:
        user_id = None
    if not user_id:
        # No owner on record is not the same as "anyone may see it".
        raise HTTPException(status_code=404, detail="Keyframe owner not recorded")
    return {"user_id": str(user_id)}


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
