from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel
from typing import Optional
from ai.pipeline import MedicationDetectionPipeline
import threading

router = APIRouter(prefix="/api/detection", tags=["AI Detection"])

# Global pipeline instance
_pipeline: Optional[MedicationDetectionPipeline] = None
_pipeline_thread: Optional[threading.Thread] = None


class DetectionStartRequest(BaseModel):
    source: str = "0"           # "0" for webcam, or video file path
    medication_id: str
    scheduled_time: str
    display: bool = False       # show video window (for testing only)


class DetectionAnalyzeRequest(BaseModel):
    medication_id: str
    scheduled_time: str


@router.post("/start")
async def start_detection(req: DetectionStartRequest):
    """Start the medication detection pipeline on a video source."""
    global _pipeline, _pipeline_thread

    if _pipeline and _pipeline.is_running:
        raise HTTPException(status_code=400, detail="Detection pipeline already running")

    _pipeline = MedicationDetectionPipeline(api_base_url="http://localhost:5000")

    source = int(req.source) if req.source.isdigit() else req.source

    def run():
        _pipeline.run_on_video(source=source, display=req.display)

    _pipeline_thread = threading.Thread(target=run, daemon=True)
    _pipeline_thread.start()

    return {"message": "Detection pipeline started", "source": req.source}


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
    }