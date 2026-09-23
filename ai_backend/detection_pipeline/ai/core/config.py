"""Environment-driven settings for the core engine.

The Mongo values are re-exported from db_config so there is exactly one answer
to "which database?" across the whole AI backend (Core FE-9).
"""

import os

from db_config import get_mongo_uri, get_db_name

MONGODB_URI = get_mongo_uri()
MONGODB_DB = get_db_name()

CAMERA_BASE_URL = os.getenv("CAMERA_BASE_URL", "rtsp://127.0.0.1:8554")
MODEL_PATH = os.getenv("MODEL_PATH", "ai/best_model.onnx")

# FE-8: 24-42 hours. Same default as keyframe.py's KEYFRAME_TTL_HOURS, which
# is what actually performs the sweep; this stayed at 72 after that moved.
KEYFRAME_RETENTION_HOURS = int(os.getenv("KEYFRAME_TTL_HOURS", os.getenv("KEYFRAME_RETENTION_HOURS", "36")))

# FE-7.
AUTO_VERIFY_THRESHOLD = float(os.getenv("AUTO_VERIFY_THRESHOLD", "0.85"))
CONFIRM_THRESHOLD = float(os.getenv("CONFIRM_THRESHOLD", "0.70"))

# FE-1: capture rises and falls between these. EVENT_FPS is the ceiling and
# must match CAPTURE_FPS in ai/pipeline.py -- it read 10 while the pipeline
# ran at 5, which is the figure the old spec quoted before it was corrected.
IDLE_FPS = float(os.getenv("IDLE_FPS", "1"))
MOTION_FPS = float(os.getenv("MOTION_FPS", "5"))
EVENT_FPS = float(os.getenv("CAPTURE_FPS", os.getenv("EVENT_FPS", "5")))
