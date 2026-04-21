from fastapi import APIRouter, BackgroundTasks, HTTPException, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from ai.pipeline import MedicationDetectionPipeline
import threading
from database import get_db
from bson import ObjectId
from utils.auth import create_access_token

router = APIRouter(prefix="/api/detection", tags=["AI Detection"])

# Global pipeline instance
_pipeline: Optional[MedicationDetectionPipeline] = None
_pipeline_thread: Optional[threading.Thread] = None


class DetectionStartRequest(BaseModel):
    source: str = "0"           # "0" for webcam, or video file path
    medication_id: str = ""
    scheduled_time: str = ""
    display: bool = False       # show video window (for testing only)
    expected_medicine_count: int = 0  # how many medicines expected at this time
    scheduled_times: list = []  # ["08:00", "20:00"] — only scan near these times


class DetectionAnalyzeRequest(BaseModel):
    medication_id: str
    scheduled_time: str


@router.post("/start")
async def start_detection(req: DetectionStartRequest, db=Depends(get_db)):
    """Start the medication detection pipeline on a video source."""
    global _pipeline, _pipeline_thread

    if _pipeline and _pipeline.is_running:
        raise HTTPException(status_code=400, detail="Detection pipeline already running")

    # Parse all medications scheduled for the requested time
    medication_ids = []
    expected_count = 0
    token = ""
    
    if req.scheduled_time:
        cursor = db.medications.find({"scheduled_times": req.scheduled_time, "is_active": True})
        meds = await cursor.to_list(length=100)
        
        if meds:
            medication_ids = [str(m["_id"]) for m in meds]
            expected_count = len(meds)
            # Generate a system token masquerading as the user of the scheduled meds
            token = create_access_token({"sub": str(meds[0]["user_id"]), "role": "system"})

    _pipeline = MedicationDetectionPipeline(
        api_base_url="http://localhost:8000",
        expected_medicine_count=expected_count,
        medication_ids=medication_ids,
        scheduled_time=req.scheduled_time,
        token=token
    )

    source = int(req.source) if req.source.isdigit() else req.source

    def run():
        _pipeline.run_on_video(
            source=source,
            display=req.display,
            scheduled_times=req.scheduled_times or None
        )

    _pipeline_thread = threading.Thread(target=run, daemon=True)
    _pipeline_thread.start()

    return {
        "message": "Detection pipeline started",
        "source": req.source,
        "expected_medicine_count": expected_count
    }


@router.post("/stop")
async def stop_detection():
    """Stop the running detection pipeline."""
    global _pipeline
    if not _pipeline or not _pipeline.is_running:
        raise HTTPException(status_code=400, detail="No pipeline is currently running")

    _pipeline.stop()
    return {"message": "Detection pipeline stopped"}


@router.post("/analyze")
async def analyze_buffer(req: DetectionAnalyzeRequest):
    """
    Return the latest analysis result.
    The pipeline thread auto-analyzes every 100 frames and at video end,
    so this simply returns the cached result without blocking the server.
    """
    global _pipeline
    if not _pipeline:
        raise HTTPException(status_code=400, detail="Pipeline not initialized. Call /start first.")

    # Return the cached auto-analysis result (computed by the pipeline thread)
    if _pipeline.last_result:
        return _pipeline.last_result

    # No cached result — try running analysis directly (fast for small buffers)
    try:
        result = _pipeline.analyze_buffer()
        if result:
            return result
    except Exception as e:
        print(f"[Analyze] Direct analysis error: {e}")

    # No result at all
    raise HTTPException(
        status_code=400,
        detail="No frames available for analysis. Make sure the pipeline has processed some video frames first."
    )


@router.get("/status")
async def get_status():
    """Check if the detection pipeline is running and return latest result if available."""
    global _pipeline
    try:
        buffer_size = len(_pipeline.extractor.get_buffer()) if _pipeline else 0
    except Exception:
        buffer_size = 0

    return {
        "is_running": _pipeline.is_running if _pipeline else False,
        "buffer_size": buffer_size,
        "has_result": bool(_pipeline and _pipeline.last_result),
        "last_result": _pipeline.last_result if _pipeline else None,
        "medicines_taken_count": _pipeline.medicines_taken_count if _pipeline else 0,
        "expected_medicine_count": _pipeline.expected_medicine_count if _pipeline else 0,
        "medicines_remaining": max(0, (_pipeline.expected_medicine_count - _pipeline.medicines_taken_count)) if _pipeline else 0,
    }


@router.get("/medicine-count")
async def get_medicine_count():
    """
    Get the current medicine intake counter for this pipeline session.
    Returns the total count, individual detection events, expected count, and remaining.
    """
    global _pipeline
    if not _pipeline:
        return {
            "medicines_taken_count": 0,
            "expected_medicine_count": 0,
            "medicines_remaining": 0,
            "detection_events": [],
        }

    return {
        "medicines_taken_count": _pipeline.medicines_taken_count,
        "expected_medicine_count": _pipeline.expected_medicine_count,
        "medicines_remaining": max(0, _pipeline.expected_medicine_count - _pipeline.medicines_taken_count),
        "detection_events": _pipeline.medicines_detected_this_session,
    }


@router.get("/keyframes")
async def list_keyframes(limit: int = 50):
    """
    List all stored keyframes with metadata (timestamps, blur scores, motion scores).
    Used by the caregiver Keyframe Audit page to display per-frame AI evidence.
    """
    from ai.keyframe import KeyframeStorage
    storage = KeyframeStorage()
    keyframes = storage.list_keyframes()
    return keyframes[:limit]


@router.get("/keyframes/{keyframe_id}/image")
async def get_keyframe_image(keyframe_id: str):
    """
    Serve a keyframe image by its ID for visual display in the caregiver dashboard.
    """
    import os
    from ai.keyframe import KEYFRAME_STORAGE_DIR

    img_path = os.path.join(KEYFRAME_STORAGE_DIR, f"{keyframe_id}.jpg")
    if not os.path.exists(img_path):
        raise HTTPException(status_code=404, detail="Keyframe image not found")

    return FileResponse(img_path, media_type="image/jpeg")