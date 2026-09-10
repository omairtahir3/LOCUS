import os

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB = os.getenv("MONGODB_DB", "locusDB")

CAMERA_BASE_URL = os.getenv("CAMERA_BASE_URL", "rtsp://127.0.0.1:8554")
MODEL_PATH = os.getenv("MODEL_PATH", "ai/best_model.onnx")

KEYFRAME_RETENTION_HOURS = int(os.getenv("KEYFRAME_RETENTION_HOURS", "72"))

AUTO_VERIFY_THRESHOLD = float(os.getenv("AUTO_VERIFY_THRESHOLD", "0.85"))
CONFIRM_THRESHOLD = float(os.getenv("CONFIRM_THRESHOLD", "0.70"))

IDLE_FPS = int(os.getenv("IDLE_FPS", "2"))
MOTION_FPS = int(os.getenv("MOTION_FPS", "5"))
EVENT_FPS = int(os.getenv("EVENT_FPS", "10"))
