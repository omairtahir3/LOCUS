from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
import os

from .keyframe import KeyframeStorage, KEYFRAME_STORAGE_DIR, EvidenceStorage, EVIDENCE_STORAGE_DIR

router = APIRouter(prefix="/api/keyframes", tags=["Keyframes"])

# Singleton storage instances
_storage = None
_evidence_storage = None


def _get_storage():
    global _storage
    if _storage is None:
        _storage = KeyframeStorage(KEYFRAME_STORAGE_DIR)
    return _storage


def _get_evidence_storage():
    global _evidence_storage
    if _evidence_storage is None:
        _evidence_storage = EvidenceStorage(EVIDENCE_STORAGE_DIR)
    return _evidence_storage


@router.get("")
async def list_keyframes(limit: int = 200, user_id: str = "", medication_only: bool = False):
    """
    List stored keyframes with metadata.

    Query params:
        user_id:         Filter by user (empty = all users)
        medication_only: If true, only return frames with medication_detected=True
        limit:           Max results (default 200)

    Caregiver dashboard: medication_only=false (see all frames)
    Elderly user:        medication_only=true  (see only verified intake frames)
    """
    storage = _get_storage()
    keyframes = storage.list_keyframes(
        user_id=user_id or None,
        medication_only=medication_only,
        limit=limit,
    )
    return keyframes


@router.get("/{keyframe_id}/image")
async def get_keyframe_image(keyframe_id: str):
    """
    Serve a keyframe image by its ID for visual display in the caregiver dashboard.
    """
    import glob
    matches = glob.glob(os.path.join(KEYFRAME_STORAGE_DIR, "*", "*", f"{keyframe_id}.jpg"))
    if matches:
        img_path = matches[0]
    else:
        img_path = os.path.join(KEYFRAME_STORAGE_DIR, f"{keyframe_id}.jpg")
        
    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Keyframe image not found")

    return FileResponse(img_path, media_type="image/jpeg")


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
        if matches:
            img_path = matches[0]
        else:
            legacy = os.path.join(KEYFRAME_STORAGE_DIR, f"{kf['keyframe_id']}.jpg")
            if os.path.exists(legacy):
                img_path = legacy
                
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

@router.get("/evidence")
async def list_evidence_frames(limit: int = 100, user_id: str = ""):
    """
    List stored medicine evidence frames (Phase 1/2/3 from successful detections).
    Sorted newest-first. Auto-cleaned after 36 hours.
    """
    storage = _get_evidence_storage()
    return storage.list_evidence(user_id=user_id or None, limit=limit)


@router.get("/evidence/{evidence_id}/image")
async def get_evidence_image(evidence_id: str):
    """
    Serve an evidence frame image by its ID.
    """
    import glob
    matches = glob.glob(os.path.join(EVIDENCE_STORAGE_DIR, "*", "*", f"{evidence_id}.jpg"))
    if matches:
        img_path = matches[0]
    else:
        img_path = os.path.join(EVIDENCE_STORAGE_DIR, f"{evidence_id}.jpg")
        
    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Evidence frame not found")

    return FileResponse(img_path, media_type="image/jpeg")
