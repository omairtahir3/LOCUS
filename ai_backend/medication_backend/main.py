from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import os
import sys

# ── Add ai_backend to Python path so keyframe_backend is importable ──
_ai_backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ai_backend_dir not in sys.path:
    sys.path.insert(0, _ai_backend_dir)

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
from keyframe_backend.routes import router as keyframe_router
from scheduler import run_scheduler, stop_scheduler, get_scheduler_status
import asyncio


@asynccontextmanager
async def lifespan(app: FastAPI):
    await connect_db()

    # ── The scheduler now handles ALL pipeline lifecycle ───────────────
    # No more always-on pipeline thread. The scheduler:
    #   1. Discovers ALL users with active medications (multi-user)
    #   2. Looks up each user's camera_stream_url from MongoDB
    #   3. Spawns per-user pipelines on-demand when medication windows open
    #   4. Tears them down when sessions expire or all meds are verified
    #
    # CAMERA_SOURCE in .env is used as a fallback when a user has no
    # camera_stream_url in their profile.
    print("[Startup] Dynamic multi-user pipeline architecture active")
    print(f"[Startup] Default camera fallback: {os.environ.get('CAMERA_SOURCE', '0')}")

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
app.include_router(keyframe_router)
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
    """Get the medication scheduler state — active sessions, verification windows, per-user pipelines."""
    return get_scheduler_status()


# ── Camera configuration API ─────────────────────────────────────────────

@app.get("/api/configure", tags=["Configuration"])
async def get_config():
    """Return current AI backend configuration."""
    from scheduler import _pipelines
    return {
        "camera_source_fallback": os.environ.get("CAMERA_SOURCE", "0"),
        "active_pipelines": len(_pipelines),
        "architecture": "dynamic_multi_user",
        "configured": True,
    }


@app.post("/api/configure", tags=["Configuration"])
async def set_config(body: dict):
    """
    Configure camera_stream_url for a specific elderly user.
    Called by the mobile app/web app to assign a camera to a user.
    Saves directly to MongoDB user profile.
    """
    user_id = body.get("user_id", "").strip()
    camera_url = body.get("camera_stream_url", "").strip()
    
    from fastapi import HTTPException
    
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id is required")
    if not camera_url:
        raise HTTPException(status_code=400, detail="camera_stream_url is required")

    from database import get_db
    from bson import ObjectId
    import bson
    
    try:
        oid = ObjectId(user_id)
    except bson.errors.InvalidId:
        raise HTTPException(status_code=400, detail="Invalid user_id format")
        
    db = get_db()
    if db is None:
        raise HTTPException(status_code=500, detail="Database not connected")

    result = await db.users.update_one(
        {"_id": oid},
        {"$set": {"camera_stream_url": camera_url}}
    )

    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f"User {user_id} not found")

    print(f"[Configure] Camera URL set for user {user_id}: {camera_url}")

    return {
        "status": "configured",
        "user_id": user_id,
        "camera_stream_url": camera_url,
        "message": f"Camera URL saved. Pipeline will auto-start at next medication window.",
    }
