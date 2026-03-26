import cv2
import numpy as np
from collections import deque
from datetime import datetime, timezone, timedelta
import base64
import uuid
import os
import json
import threading
import time
import glob


# ─── Local frame storage ─────────────────────────────────────────────
KEYFRAME_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "keyframe_storage"
)

# Time-to-live: frames are auto-deleted after this many hours
KEYFRAME_TTL_HOURS = 36  # midpoint of 24-42 hour range


class KeyframeStorage:
    """
    Persists keyframe images to disk with automatic TTL-based cleanup.
    
    Storage layout:
        keyframe_storage/
            <uuid>.jpg          — the frame image
            <uuid>.json         — metadata (timestamp, motion_score, etc.)
    
    A background thread runs every 30 minutes and deletes any files
    whose timestamp is older than KEYFRAME_TTL_HOURS.
    """

    def __init__(self, storage_dir=KEYFRAME_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        self.storage_dir = storage_dir
        self.ttl_hours = ttl_hours
        os.makedirs(self.storage_dir, exist_ok=True)

        # Start background cleanup thread
        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)
        self._cleanup_thread.start()

    def save(self, keyframe_id, frame, metadata):
        """
        Save a keyframe image and its metadata to disk.
        
        Args:
            keyframe_id: UUID string
            frame:       raw numpy frame (BGR)
            metadata:    dict with timestamp, motion_score, etc.
        """
        img_path  = os.path.join(self.storage_dir, f"{keyframe_id}.jpg")
        meta_path = os.path.join(self.storage_dir, f"{keyframe_id}.json")

        cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

        meta = {
            **metadata,
            "file": f"{keyframe_id}.jpg",
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=2)

    def load_frame(self, keyframe_id):
        """Load a saved frame from disk by its ID. Returns numpy array or None."""
        img_path = os.path.join(self.storage_dir, f"{keyframe_id}.jpg")
        if not os.path.exists(img_path):
            return None
        return cv2.imread(img_path)

    def load_metadata(self, keyframe_id):
        """Load metadata for a saved keyframe."""
        meta_path = os.path.join(self.storage_dir, f"{keyframe_id}.json")
        if not os.path.exists(meta_path):
            return None
        with open(meta_path, "r") as f:
            return json.load(f)

    def list_keyframes(self):
        """List all stored keyframe IDs, sorted by timestamp (newest first)."""
        meta_files = glob.glob(os.path.join(self.storage_dir, "*.json"))
        keyframes = []
        for meta_path in meta_files:
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
                    meta["keyframe_id"] = os.path.basename(meta_path).replace(".json", "")
                    keyframes.append(meta)
            except (json.JSONDecodeError, IOError):
                continue
        keyframes.sort(key=lambda k: k.get("saved_at", ""), reverse=True)
        return keyframes

    def cleanup_expired(self):
        """Delete all keyframes older than TTL."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=self.ttl_hours)
        deleted = 0

        meta_files = glob.glob(os.path.join(self.storage_dir, "*.json"))
        for meta_path in meta_files:
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)

                saved_at = meta.get("saved_at", "")
                if not saved_at:
                    continue

                # Parse ISO timestamp
                frame_time = datetime.fromisoformat(saved_at)
                if frame_time.tzinfo is None:
                    frame_time = frame_time.replace(tzinfo=timezone.utc)

                if frame_time < cutoff:
                    keyframe_id = os.path.basename(meta_path).replace(".json", "")
                    img_path = os.path.join(self.storage_dir, f"{keyframe_id}.jpg")

                    if os.path.exists(img_path):
                        os.remove(img_path)
                    os.remove(meta_path)
                    deleted += 1

            except (json.JSONDecodeError, IOError, ValueError):
                continue

        if deleted > 0:
            print(f"[KeyframeStorage] Cleaned up {deleted} expired keyframe(s)")
        return deleted

    def _cleanup_loop(self):
        """Background loop — runs cleanup every 30 minutes."""
        while True:
            time.sleep(30 * 60)  # 30 minutes
            try:
                self.cleanup_expired()
            except Exception as e:
                print(f"[KeyframeStorage] Cleanup error: {e}")


class KeyframeExtractor:
    """
    Extracts keyframes from video feed at adaptive FPS.
    Increases capture rate during motion, reduces during inactivity.
    Maintains a 5-10 second temporal buffer for sequence analysis.

    Quality filtering:
    - AI Pipeline: Uses all adaptive motion-captured frames, even if blurry.
    - Disk Storage: Saves only the sharpest (highest Laplacian variance) frame
      per 1-second window.
    """

    def __init__(self, target_fps=10, buffer_seconds=10, save_locally=True,
                 blur_threshold=100.0, window_duration=1.0):
        self.target_fps = target_fps
        self.buffer_seconds = buffer_seconds
        self.buffer = deque(maxlen=target_fps * buffer_seconds)
        self._lock = threading.Lock()  # Thread-safe buffer access
        self.prev_frame = None
        self.motion_threshold = 10
        self.frame_count = 0

        # Blur detection threshold — frames below this are rejected
        # Higher value = stricter (only very sharp frames pass)
        self.blur_threshold = blur_threshold

        # Best-frame-per-window: collect candidates over this duration
        # Assuming a ~30fps camera, 1 second = 30 frames.
        self.window_frames = int(30 * window_duration)
        self._window_candidates = []   # list of (blur_score, keyframe_id, frame, metadata)

        # Local storage (enabled by default)
        self.save_locally = save_locally
        self.storage = KeyframeStorage() if save_locally else None

    def compute_motion_score(self, frame):
        """Compare current frame to previous to detect motion level."""
        if self.prev_frame is None:
            self.prev_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            return 0

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        diff = cv2.absdiff(self.prev_frame, gray)
        score = np.mean(diff)
        self.prev_frame = gray
        return score

    def compute_blur_score(self, frame):
        """
        Compute image sharpness using Laplacian variance.
        Higher score = sharper image.
        Typical values: <50 very blurry, 50-100 soft, >100 sharp.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        return float(cv2.Laplacian(gray, cv2.CV_64F).var())

    def should_capture(self, motion_score):
        """
        Adaptive capture decision:
        - High motion → always capture
        - Low motion → capture every N frames to save storage
        """
        if motion_score > self.motion_threshold:
            return True
        # Capture 1 frame per ~3 frames during low motion for gesture tracking
        return self.frame_count % 3 == 0

    def extract_keyframe(self, frame, motion_score, blur_score):
        """
        Package a frame into a keyframe record and add to in-memory buffer.
        Does NOT save to disk — disk persistence is handled by the
        best-frame-per-window logic in process_frame().
        """
        keyframe_id = str(uuid.uuid4())
        timestamp = datetime.now(timezone.utc).isoformat()

        _, jpg_buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        encoded = base64.b64encode(jpg_buffer).decode('utf-8')

        keyframe = {
            "id": keyframe_id,
            "timestamp": timestamp,
            "motion_score": round(float(motion_score), 2),
            "blur_score": round(blur_score, 2),
            "frame_data": encoded,  # base64 encoded JPEG (in-memory buffer)
            "width": frame.shape[1],
            "height": frame.shape[0],
        }
        self.buffer.append(keyframe)

        return keyframe

    def _flush_window(self):
        """
        Save the sharpest frame from the current 1-second window to disk.
        Called when the window duration expires.
        """
        if not self._window_candidates or not self.storage:
            self._window_candidates = []
            return

        # Pick the candidate with the highest blur score (sharpest)
        best = max(self._window_candidates, key=lambda c: c[0])
        blur_score, keyframe_id, frame, metadata = best

        self.storage.save(keyframe_id, frame, metadata)
        
        # CLEAR the candidates list to start fresh for the next window
        self._window_candidates = []

        self._window_candidates = []

    def get_buffer(self):
        """Return current temporal buffer as list (thread-safe)."""
        with self._lock:
            return list(self.buffer)

    def get_frames_for_analysis(self):
        """Return decoded frames from buffer for model inference (thread-safe)."""
        with self._lock:
            snapshot = list(self.buffer)
        frames = []
        for kf in snapshot:
            img_data = base64.b64decode(kf["frame_data"])
            nparr = np.frombuffer(img_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            frames.append({"frame": frame, "timestamp": kf["timestamp"], "id": kf["id"]})
        return frames

    def process_frame(self, frame):
        """
        Main method — call this for every frame from the camera.

        Flow:
        1. Compute motion score & blur score for the frame.
        2. Best-frame-per-window: Consider EVERY frame for disk persistence,
           collecting candidates in a 1-second window to save the absolute sharpest.
        3. In-memory buffer: Apply adaptive capture (motion-based FPS reduction).
           All captured frames (even blurry ones) go to the AI models.

        Returns keyframe if captured into buffer, None otherwise.
        """
        self.frame_count += 1
        motion_score = self.compute_motion_score(frame)
        blur_score = self.compute_blur_score(frame)

        # 1. Best-frame-per-window: Always collect candidates for disk persistence,
        #    even if they are blurry. We want the best frame of the window, period.
        if self.save_locally and self.storage:
            # We need an ID and timestamp even if we don't put it in the buffer yet
            temp_id = str(uuid.uuid4())
            temp_time = datetime.now(timezone.utc).isoformat()
            
            metadata = {
                "id": temp_id,
                "timestamp": temp_time,
                "motion_score": round(float(motion_score), 2),
                "blur_score": round(blur_score, 2),
                "width": frame.shape[1],
                "height": frame.shape[0],
            }
            self._window_candidates.append((blur_score, temp_id, frame.copy(), metadata))

            # Flush based on frame count rather than wall-clock time.
            # This ensures consistent extraction even if processing slows down.
            if self.frame_count % self.window_frames == 0:
                self._flush_window()

        # 2. In-memory buffer for AI pipeline
        #    - Apply adaptive capture (skip frames during low motion)
        #    - We no longer reject blurry frames here per user request.
        if not self.should_capture(motion_score):
            return None

        # Frame passed motion check — add to in-memory buffer
        # We reuse the temp_id/temp_time if we created them above
        keyframe_id = temp_id if 'temp_id' in locals() else str(uuid.uuid4())
        timestamp = temp_time if 'temp_time' in locals() else datetime.now(timezone.utc).isoformat()
        
        _, jpg_buffer = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        encoded = base64.b64encode(jpg_buffer).decode('utf-8')

        keyframe = {
            "id": keyframe_id,
            "timestamp": timestamp,
            "motion_score": round(float(motion_score), 2),
            "blur_score": round(blur_score, 2),
            "frame_data": encoded,
            "width": frame.shape[1],
            "height": frame.shape[0],
        }
        with self._lock:
            self.buffer.append(keyframe)

        return keyframe


class VideoSource:
    """
    Abstracts the video input source.
    Supports webcam, video file, and will support wearable camera stream.
    """

    def __init__(self, source=0):
        """
        source=0 for webcam
        source="path/to/video.mp4" for file
        source="rtsp://..." for camera stream
        """
        self.source = source
        self.cap = None

    def open(self):
        self.cap = cv2.VideoCapture(self.source)
        if not self.cap.isOpened():
            raise RuntimeError(f"Could not open video source: {self.source}")
        print(f"Video source opened: {self.source}")
        return self

    def read(self):
        """Read next frame. Returns (success, frame)."""
        if self.cap is None:
            return False, None
        return self.cap.read()

    def release(self):
        if self.cap:
            self.cap.release()
            print("Video source released")

    def get_fps(self):
        return self.cap.get(cv2.CAP_PROP_FPS) if self.cap else 0

    def __enter__(self):
        return self.open()

    def __exit__(self, *args):
        self.release()