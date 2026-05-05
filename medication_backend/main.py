from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os

# ── Load .env into os.environ ──────────────────────────────────────────
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _key, _, _val = _line.partition("=")
                os.environ.setdefault(_key.strip(), _val.strip())

from database import connect_db, close_db, get_settings
from routes.auth import router as auth_router
from routes.medication import router as medication_router
from ai.routes_detection import router as detection_router
from routes.caregiver import router as caregiver_router
from routes.notifications import router as notification_router
from scheduler import run_scheduler, stop_scheduler, get_scheduler_status
import asyncio


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()

    # ── Start AI pipeline (always-on, 24/7) ───────────────────────────
    # The pipeline runs continuously in the background reading from CAMERA_SOURCE (mediamtx).
    # When you start the stream from the GoPro Quik app, it will instantly begin detection.
    import threading, os
    from ai.pipeline import MedicationDetectionPipeline

    def _start_pipeline_background():
        camera_source = os.environ.get("CAMERA_SOURCE", "0")
        
        print(f"[Startup] Starting always-on AI pipeline on: {camera_source}")
        pipeline = MedicationDetectionPipeline(
            api_base_url="http://localhost:8000",
            expected_medicine_count=0,  # scheduler sets this per session
        )

        # Register with scheduler so it can update medication context per session
        from scheduler import register_pipeline
        register_pipeline(pipeline)

        # Retry forever — if the camera/stream dies, wait and reconnect
        import time as _time
        while True:
            try:
                pipeline.run_on_video(
                    source=camera_source,
                    display=False,
                    scheduled_times=None,
                )
                # run_on_video returned normally (stream ended) — retry
                print("[Startup] Pipeline exited. Restarting in 10s...")
            except Exception as e:
                print(f"[Startup] Pipeline crashed: {e}. Restarting in 10s...")
            
            # Reset pipeline state for next run
            pipeline.is_running = False
            _time.sleep(10)
            pipeline.is_running = True  # will be set properly inside run_on_video

    pipeline_thread = threading.Thread(target=_start_pipeline_background, daemon=True)
    pipeline_thread.start()

    # ── Start medication scheduler ─────────────────────────────────────
    scheduler_task = asyncio.create_task(run_scheduler())
    yield
    stop_scheduler()
    scheduler_task.cancel()
    await close_db()


settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="Backend API for MemoryAssist — medication tracking, behavioral monitoring, and caregiver dashboard.",
    lifespan=lifespan
)

# Allow requests from web dashboard and mobile app during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict to your domain in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# from routes.memory import router as memory_router

# Register routes
app.include_router(auth_router)
app.include_router(medication_router)
app.include_router(detection_router)
app.include_router(caregiver_router)
app.include_router(notification_router)
# app.include_router(memory_router)


@app.get("/", tags=["Health"])
async def root():
    return {
        "app": settings.app_name,
        "version": settings.app_version,
        "status": "running",
        "docs": "/docs"
    }


@app.get("/health", tags=["Health"])
async def health():
    return {"status": "ok"}


@app.get("/api/scheduler/status", tags=["Scheduler"])
async def scheduler_status():
    """Get the medication scheduler state — active sessions, verification windows."""
    return get_scheduler_status()


