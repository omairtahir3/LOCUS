from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
import os

from .keyframe import KeyframeStorage, KEYFRAME_STORAGE_DIR, MedicationEvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR, SOCIAL_STORAGE_DIR

router = APIRouter(prefix="/api/keyframes", tags=["Keyframes"])

# Singleton storage instances
_storage = None
_evidence_storage = None
_social_storage = None


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
async def list_keyframes(limit: int = 200, user_id: str = "", medication_only: bool = False):
    """
    List stored keyframes with metadata.
    """
    storage = _get_storage()
    keyframes = storage.list_keyframes(
        user_id=user_id or None,
        medication_only=medication_only,
        limit=limit,
    )
    
    if keyframes:
        try:
            from pymongo import MongoClient
            client = MongoClient("mongodb://localhost:27017")
            db = client["locusDB"]
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
                
        except Exception as e:
            print(f"Error fetching flags for keyframes: {e}")
            for k in keyframes:
                if "is_flagged" not in k: k["is_flagged"] = False
                
    return keyframes


@router.get("/{keyframe_id}/image")
async def get_keyframe_image(keyframe_id: str):
    """
    Serve a keyframe image by its ID for visual display in the caregiver dashboard.
    """
    import glob
    matches = glob.glob(os.path.join(KEYFRAME_STORAGE_DIR, "*", "*", f"{keyframe_id}.jpg"))
    if not matches:
        matches = glob.glob(os.path.join(SOCIAL_STORAGE_DIR, "*", "*", f"{keyframe_id}.jpg"))
        
    if matches:
        img_path = matches[0]
    else:
        img_path = os.path.join(KEYFRAME_STORAGE_DIR, f"{keyframe_id}.jpg")
        
    if not os.path.exists(img_path):
        # Fallback for old social frames
        legacy_social = os.path.join(SOCIAL_STORAGE_DIR, f"{keyframe_id}.jpg")
        if os.path.exists(legacy_social):
            img_path = legacy_social
            
    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Keyframe image not found")

    return FileResponse(img_path, media_type="image/jpeg", headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


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
            client = MongoClient("mongodb://localhost:27017")
            db = client["locusDB"]
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


@router.get("/medication_frames/{evidence_id}/image")
async def get_medication_frame_image(evidence_id: str):
    """
    Serve an evidence frame image by its ID.
    """
    import glob
    matches = glob.glob(os.path.join(MEDICATION_EVIDENCE_STORAGE_DIR, "*", "*", f"{evidence_id}.jpg"))
    if matches:
        img_path = matches[0]
    else:
        img_path = os.path.join(MEDICATION_EVIDENCE_STORAGE_DIR, f"{evidence_id}.jpg")
        
    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Evidence frame not found")

    return FileResponse(img_path, media_type="image/jpeg", headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
