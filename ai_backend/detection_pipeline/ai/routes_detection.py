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


def _default_camera_source():
    """Read CAMERA_SOURCE from env, defaulting to '0' (webcam)."""
    import os
    return os.environ.get("CAMERA_SOURCE", "0")


class DetectionStartRequest(BaseModel):
    source: str = ""            # empty = read from CAMERA_SOURCE env var
    user_id: str = ""           # explicitly provided user ID
    medication_id: str = ""
    scheduled_time: str = ""
    display: bool = False       # show video window (for testing only)
    expected_medicine_count: int = 0  # how many medicines expected at this time
    scheduled_times: list = []  # ["08:00", "20:00"] — only scan near these times
    test_mode: bool = False     # if True, creates dummy medication for stream testing
    confidence_thresholds: dict = {}  # User-specific threshold overrides


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
    scheduled_time_used = req.scheduled_time
    all_scheduled_times = req.scheduled_times or []
    
    # TEST MODE: use dummy medication for stream testing without DB
    if req.test_mode:
        medication_ids = ["test_mode_dummy"]
        expected_count = 1
        if not scheduled_time_used:
            from datetime import datetime
            scheduled_time_used = datetime.now().strftime("%H:%M")  # Current time
        all_scheduled_times = [scheduled_time_used]
        user_id = req.user_id or "test_user"
        print(f"[Detection] TEST MODE: Using dummy medication at {scheduled_time_used}")
        meds = []  # No DB lookup needed
    elif req.medication_id:
        # Explicit medication ID provided
        from bson import ObjectId
        m = await db.medications.find_one({"_id": ObjectId(req.medication_id)})
        meds = [m] if m else []
    elif req.scheduled_time:
        # Explicit time provided — find medications at that exact time
        cursor = db.medications.find({"scheduled_times": req.scheduled_time, "is_active": True})
        meds = await cursor.to_list(length=100)
    else:
        # No time provided — auto-detect medications due within ±3 hours
        from datetime import datetime, timedelta
        # Calculate true local time by applying the system's timezone offset
        local_now = datetime.now()
        utc_now = datetime.utcnow()
        offset = local_now - utc_now
        
        # We want the time to match the user's local wall-clock time
        now = local_now
        current_minutes = now.hour * 60 + now.minute
        window = 180  # 3-hour window
        
        cursor = db.medications.find({"is_active": True})
        all_meds = await cursor.to_list(length=100)
        meds = []
        
        for m in all_meds:
            for t in m.get("scheduled_times", []):
                try:
                    parts = t.split(":")
                    sched_min = int(parts[0]) * 60 + int(parts[1])
                    raw_diff = current_minutes - sched_min
                    abs_diff = abs(raw_diff)
                    wrap_diff = 1440 - abs_diff
                    diff = min(abs_diff, wrap_diff)
                    if diff <= window:
                        meds.append(m)
                        
                        # Determine the correct DATE for this scheduled time.
                        # If we matched via midnight wrap-around (scheduled time is
                        # in the evening but current time is past midnight), the
                        # scheduled time belongs to YESTERDAY, not today.
                        # Example: current=00:08 (8 min), sched=21:30 (1290 min)
                        #   raw_diff = 8 - 1290 = -1282, wrap is closer (158 min)
                        #   Since current < sched and wrap was used, it's yesterday.
                        used_wrap = wrap_diff < abs_diff
                        if used_wrap and current_minutes < sched_min:
                            # Past midnight, matched an evening schedule → yesterday
                            yesterday = (now - timedelta(days=1)).strftime("%Y-%m-%d")
                            adjusted_time = f"{yesterday}T{t}"
                            print(f"[Detection] Midnight wrap: {t} assigned to yesterday ({yesterday})")
                        elif used_wrap and current_minutes > sched_min:
                            # Late evening, matched an early morning schedule → tomorrow
                            tomorrow = (now + timedelta(days=1)).strftime("%Y-%m-%d")
                            adjusted_time = f"{tomorrow}T{t}"
                            print(f"[Detection] Midnight wrap: {t} assigned to tomorrow ({tomorrow})")
                        else:
                            adjusted_time = t  # same day, no adjustment needed
                        
                        if not scheduled_time_used:
                            scheduled_time_used = adjusted_time
                        if adjusted_time not in all_scheduled_times:
                            all_scheduled_times.append(adjusted_time)
                        break
                except (ValueError, IndexError):
                    continue
        
        if meds:
            print(f"[Detection] Auto-detected {len(meds)} medications due near {now.strftime('%H:%M')}: "
                  f"{[m.get('name','?') for m in meds]}")
    
    user_id = req.user_id
    if meds:
        medication_ids = [str(m["_id"]) for m in meds]
        expected_count = len(meds)
        # If no explicit user_id was provided, infer from meds
        if not user_id:
            user_id = str(meds[0]["user_id"])
            
    if user_id:
        token = create_access_token({"sub": user_id, "role": "system"})

    _pipeline = MedicationDetectionPipeline(
        api_base_url="http://localhost:8000",
        expected_medicine_count=expected_count,
        medication_ids=medication_ids,
        scheduled_time=scheduled_time_used,
        token=token,
        user_id=user_id,
        confidence_thresholds=req.confidence_thresholds
    )
    
    # For testing: force active to bypass schedule window checking
    _pipeline.force_active = True

    # Resolve video source: use env var if not explicitly provided
    raw_source = req.source.strip() if req.source else ""
    if not raw_source:
        raw_source = _default_camera_source()
    source = int(raw_source) if raw_source.isdigit() else raw_source

    def run():
        _pipeline.run_on_video(
            source=source,
            display=req.display,
            scheduled_times=all_scheduled_times or None
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
        import traceback
        err = traceback.format_exc()
        print(f"[Analyze] Direct analysis error: {err}")
        with open("quickscan.log", "a") as f:
            f.write(f"\n[Error in Direct Analysis]\n{err}\n")

    # No result at all
    raise HTTPException(
        status_code=400,
        detail="No frames available for analysis. Make sure the pipeline has processed some video frames first."
    )


@router.get("/status")
async def get_status():
    """Check if the detection pipeline is running and return latest result if available."""
    global _pipeline

    # Fall back to the scheduler's always-on pipeline if routes_detection's own is None
    pipe = _pipeline
    if not pipe:
        try:
            from scheduler import _pipeline as sched_pipeline
            pipe = sched_pipeline
        except Exception:
            pass

    try:
        buffer_size = len(pipe.extractor.get_buffer()) if pipe else 0
    except Exception:
        buffer_size = 0

    # Sanitize last_result — strip numpy arrays and other non-serializable fields
    safe_result = None
    if pipe and pipe.last_result:
        try:
            import numpy as np
            def _sanitize(obj):
                if isinstance(obj, dict):
                    return {k: _sanitize(v) for k, v in obj.items()
                            if not isinstance(v, np.ndarray) and k not in ("frame", "raw_frame", "_evidence_frames", "kf")}
                elif isinstance(obj, (list, tuple)):
                    return [_sanitize(item) for item in obj if not isinstance(item, np.ndarray)]
                elif isinstance(obj, np.ndarray):
                    return None
                elif isinstance(obj, (np.float32, np.float64)):
                    return float(obj)
                elif isinstance(obj, (np.int32, np.int64)):
                    return int(obj)
                return obj
            safe_result = _sanitize(pipe.last_result)
        except Exception:
            safe_result = {"error": "Could not serialize last_result"}

    return {
        "is_running": pipe.is_running if pipe else False,
        "camera_online": getattr(pipe, 'camera_online', False) if pipe else False,
        "buffer_size": buffer_size,
        "has_result": bool(pipe and pipe.last_result),
        "last_result": safe_result,
        "medicines_taken_count": pipe.medicines_taken_count if pipe else 0,
        "expected_medicine_count": pipe.expected_medicine_count if pipe else 0,
        "medicines_remaining": max(0, (pipe.expected_medicine_count - pipe.medicines_taken_count)) if pipe else 0,
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


class RewatchRequest(BaseModel):
    medication_id: str
    user_id: str
    scheduled_time: str  # "HH:MM" or "2026-05-08T16:30"


@router.post("/rewatch")
async def rewatch_medication_route(req: RewatchRequest):
    """
    Re-start watching for a medication that was manually marked as 'not taken'.
    Creates a new 2-hour verification window and points the pipeline at it.
    """
    try:
        from scheduler import rewatch_medication
        result = await rewatch_medication(req.medication_id, req.user_id, req.scheduled_time)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except ImportError:
        raise HTTPException(status_code=500, detail="Scheduler not available")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Keyframe routes have been moved to keyframe_backend/routes.py