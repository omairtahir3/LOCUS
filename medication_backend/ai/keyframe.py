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
        print(f"[KeyframeStorage] Initialized at: {self.storage_dir}")
        
        # Test write access
        try:
            test_path = os.path.join(self.storage_dir, ".write_test")
            with open(test_path, "w") as f:
                f.write("test")
            os.remove(test_path)
        except Exception as e:
            print(f"[KeyframeStorage] CRITICAL: No write access to {self.storage_dir}: {e}")

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

        # Absolute path for debugging
        abs_img_path = os.path.abspath(img_path)
        # print(f"[KeyframeStorage] Saving: {abs_img_path}") # reduced noise

        success = cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not success:
            print(f"[KeyframeStorage] ERROR: Failed to write image to {abs_img_path}")

        meta = {
            **metadata,
            "file": f"{keyframe_id}.jpg",
            "saved_at": datetime.now().astimezone().isoformat(),
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

    def list_keyframes(self, user_id=None, medication_only=False):
        """
        List stored keyframes, sorted newest-first.

        Args:
            user_id:         If set, only return keyframes for this user.
            medication_only: If True, only return keyframes tagged with
                             medication_detected=True (verified intake frames).
        """
        meta_files = glob.glob(os.path.join(self.storage_dir, "*.json"))
        keyframes = []
        for meta_path in meta_files:
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
                    meta["keyframe_id"] = os.path.basename(meta_path).replace(".json", "")

                    # Filter by user
                    if user_id and meta.get("user_id") != user_id:
                        continue
                    # Filter by medication detection
                    if medication_only and not meta.get("medication_detected"):
                        continue

                    keyframes.append(meta)
            except (json.JSONDecodeError, IOError):
                continue
        keyframes.sort(key=lambda k: k.get("saved_at", ""), reverse=True)
        return keyframes

    def tag_as_medication_detected(self, keyframe_id, confidence=0.0, status="taken",
                                    medication_name="", medication_id=""):
        """
        Update a keyframe's metadata to mark it as a medication detection frame.
        Called by the pipeline after a successful detection.
        """
        meta_path = os.path.join(self.storage_dir, f"{keyframe_id}.json")
        if not os.path.exists(meta_path):
            return False
        try:
            with open(meta_path, "r") as f:
                meta = json.load(f)
            meta["medication_detected"] = True
            meta["detection_confidence"] = round(confidence, 3)
            meta["detection_status"] = status
            meta["medication_name"] = medication_name
            meta["medication_id"] = medication_id
            meta["detected_at"] = datetime.now().astimezone().isoformat()
            with open(meta_path, "w") as f:
                json.dump(meta, f, indent=2)
            return True
        except Exception as e:
            print(f"[KeyframeStorage] Tag error for {keyframe_id}: {e}")
            return False

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

    def __init__(self, target_fps=5, buffer_seconds=5, save_locally=True,
                 blur_threshold=25.0, window_duration=1.0, top_n_per_window=5,
                 max_buffer_frames=300, user_id=""):
        self.target_fps = target_fps
        self.buffer_seconds = buffer_seconds
        self.user_id = user_id
        # Buffer holds recent frames for AI analysis.
        # Capped at max_buffer_frames to prevent memory exhaustion
        # during long sessions (e.g. 5-6 hour GoPro recording).
        # 300 frames ≈ 10 seconds at 30fps — plenty for phase analysis.
        self.max_buffer_frames = max_buffer_frames
        self.buffer = deque(maxlen=max_buffer_frames)
        self._lock = threading.Lock()
        self.prev_frame = None
        self.motion_threshold = 10
        self.frame_count = 0

        self.blur_threshold = blur_threshold

        # Window: flush every window_duration seconds using wall-clock time
        self.window_duration = window_duration
        self._window_start_time = time.time()
        self._window_candidates = []

        # Save the top N sharpest frames per 1-second window to disk
        self.top_n_per_window = top_n_per_window

        # Local storage
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
        # Capture 1 frame per ~6 frames during low motion (saves CPU)
        return self.frame_count % 6 == 0

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
        Evaluate the accumulated frames over the last window_duration seconds.
        Selects top_n_per_window sharpest frames and saves them.
        """
        if not self._window_candidates or not self.storage:
            print(f"[Keyframe] Flush skipped: candidates={len(self._window_candidates)}, storage={bool(self.storage)}")
            self._window_candidates = []
            return

        # Sort by blur score (sharpest first), filter out blurry frames, take top N
        sorted_candidates = sorted(self._window_candidates, key=lambda c: c[0], reverse=True)
        sharp_candidates = [c for c in sorted_candidates if c[0] >= self.blur_threshold]
        top_candidates = sharp_candidates[:self.top_n_per_window]

        print(f"[Keyframe] Window ended: {len(self._window_candidates)} total frames. Best score: {sorted_candidates[0][0]:.2f}. Sharp frames: {len(sharp_candidates)}")

        if not top_candidates:
            print(f"[Keyframe] Skipped window: all {len(self._window_candidates)} frames below threshold {self.blur_threshold}")
            self._window_candidates = []
            self._window_start_time = time.time()
            return  # all frames in this window were blurry — skip

        for blur_score, keyframe_id, frame, metadata in top_candidates:
            self.storage.save(keyframe_id, frame, metadata)

        print(f"[Keyframe] Saved {len(top_candidates)} sharp of {len(self._window_candidates)} frames "
              f"(sharpest={top_candidates[0][0]:.1f}, threshold={self.blur_threshold})")

        self._window_candidates = []
        self._window_start_time = time.time()

    def flush_remaining(self):
        """
        Flush any remaining window candidates when the video ends.
        Without this, the last incomplete window is lost.
        """
        if self._window_candidates and self.storage:
            print(f"[KeyframeExtractor] Flushing remaining {len(self._window_candidates)} candidates from final window")
            self._flush_window()

    def get_buffer(self):
        """Return current temporal buffer as list (thread-safe)."""
        with self._lock:
            return list(self.buffer)

    def get_frames_for_analysis(self):
        """
        Return frames from buffer for model inference (thread-safe).
        Caps to MAX_ANALYSIS_FRAMES by striding through the buffer.
        The temporal phase analysis only needs ~15 well-distributed
        frames to detect the pill→grip→gone sequence.
        """
        MAX_ANALYSIS_FRAMES = 15

        with self._lock:
            snapshot = list(self.buffer)
        if not snapshot:
            return []

        n = len(snapshot)

        # If buffer is small enough, use all frames
        if n <= MAX_ANALYSIS_FRAMES:
            selected = snapshot
        else:
            # Stride through buffer to pick evenly-spaced frames
            step = n / MAX_ANALYSIS_FRAMES
            indices = [int(i * step) for i in range(MAX_ANALYSIS_FRAMES)]
            # Always include last frame
            if indices[-1] != n - 1:
                indices[-1] = n - 1
            selected = [snapshot[i] for i in indices]

        frames = []
        for kf in selected:
            frame = kf["raw_frame"]
            frames.append({"frame": frame, "timestamp": kf["timestamp"], "id": kf["id"]})

        print(f"[Analysis] Analyzing {len(frames)} frames (from {n} in buffer)")
        return frames


    def process_frame(self, frame):
        """
        Main method — call for every frame from the camera.

        1. ALL frames go into in-memory buffer for AI analysis.
        2. Top 5 sharpest frames per second are saved to disk.
        """
        self.frame_count += 1
        if self.frame_count % 100 == 0:
            print(f"[KeyframeExtractor] Processed {self.frame_count} frames... (Buffer: {len(self.buffer)})")
        motion_score = self.compute_motion_score(frame)
        blur_score = self.compute_blur_score(frame)

        keyframe_id = str(uuid.uuid4())
        timestamp = datetime.now().astimezone().isoformat()

        # 1. Disk: collect candidates, flush every 1 second by wall-clock
        if self.save_locally and self.storage:
            metadata = {
                "id": keyframe_id,
                "timestamp": timestamp,
                "motion_score": round(float(motion_score), 2),
                "blur_score": round(blur_score, 2),
                "width": frame.shape[1],
                "height": frame.shape[0],
                "user_id": getattr(self, "user_id", "")
            }
            self._window_candidates.append((blur_score, keyframe_id, frame.copy(), metadata))

            # Flush when 1 second of wall-clock time has passed
            elapsed = time.time() - self._window_start_time
            if elapsed >= self.window_duration:
                self._flush_window()

        # 2. AI buffer: ALL frames go in for analysis
        keyframe = {
            "id": keyframe_id,
            "timestamp": timestamp,
            "motion_score": round(float(motion_score), 2),
            "blur_score": round(blur_score, 2),
            "raw_frame": frame,
            "width": frame.shape[1],
            "height": frame.shape[0],
        }
        with self._lock:
            self.buffer.append(keyframe)

        return keyframe


import threading
import time

class VideoSource:
    """
    Abstracts the video input source.
    Supports webcam, video file, and GoPro Hero 13 WiFi/RTMP stream.
    Uses a background thread to read frames, preventing buffer lag on live streams.
    """

    def __init__(self, source=0):
        """
        source=0 for webcam
        source="path/to/video.mp4" for file
        source="gopro" for GoPro Hero 13 WiFi preview stream
        source="rtmp://..." for live stream
        """
        self.source = source
        self.cap = None
        self._is_gopro = False

        self._frame = None
        self._ret = False
        self._running = False
        self._thread = None
        
        # We need threading for live streams to avoid infinite buffer latency
        self._is_live = isinstance(source, int) or (isinstance(source, str) and ("rtmp://" in source or "rtsp://" in source or "gopro" in source.lower()))

    def open(self):
        if isinstance(self.source, str) and self.source.lower() == "gopro":
            from ai.gopro import GoProSource
            self.cap = GoProSource()
            self.cap.open()
            self._is_gopro = True
            
            # Start background reader for GoPro WiFi stream
            self._running = True
            self._thread = threading.Thread(target=self._update, daemon=True)
            self._thread.start()
        else:
            # Optimize OpenCV for RTMP/RTSP streams (reduce buffer size)
            if isinstance(self.source, str) and ("rtmp://" in self.source or "rtsp://" in self.source):
                import os
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "fflags;nobuffer|analyzeduration;0|probesize;32"
                
            self.cap = cv2.VideoCapture(self.source)
            if getattr(cv2, 'CAP_PROP_BUFFERSIZE', None) is not None:
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            # Retry for RTSP/RTMP streams — the publisher (GoPro) may not be live yet
            if not self.cap.isOpened() and self._is_live:
                max_retries = 60  # 5 minutes of retrying
                for attempt in range(1, max_retries + 1):
                    print(f"[VideoSource] Stream not available, retrying in 5s... ({attempt}/{max_retries})")
                    time.sleep(5)
                    self.cap = cv2.VideoCapture(self.source)
                    if self.cap.isOpened():
                        break
            
            if not self.cap.isOpened():
                raise RuntimeError(f"Could not open video source: {self.source}")
                
            if self._is_live:
                # Prime the first frame
                self._ret, self._frame = self.cap.read()
                self._running = True
                self._thread = threading.Thread(target=self._update, daemon=True)
                self._thread.start()

        print(f"Video source opened: {self.source}")
        return self

    def _update(self):
        """Background thread that constantly reads the latest frame to clear the buffer."""
        while self._running:
            if self.cap:
                ret, frame = self.cap.read()
                if ret:
                    self._ret, self._frame = ret, frame
                    self._new_frame = True
                else:
                    self._ret = False
                    self._running = False
                    break
            else:
                time.sleep(0.005)

    def read(self):
        """Read next frame. Returns (success, frame)."""
        if self.cap is None:
            return False, None
            
        if self._is_live:
            if self._is_gopro:
                return self.cap.read()
                
            # Wait for a truly NEW frame so the AI pipeline doesn't spin out of control processing duplicates
            timeout = 0
            while not getattr(self, '_new_frame', False) and timeout < 100:
                time.sleep(0.005)
                timeout += 1
                
            self._new_frame = False
            return self._ret, self._frame
        else:
            return self.cap.read()

    def release(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=1.0)
            
        if self.cap:
            self.cap.release()
            print("Video source released")

    def get_fps(self):
        if self.cap is None:
            return 0
        if self._is_gopro:
            return self.cap.get_fps()
        fps = self.cap.get(cv2.CAP_PROP_FPS)
        return fps if fps > 0 else 30.0

    def isOpened(self):
        if self.cap is None:
            return False
        return self.cap.isOpened()

    def __enter__(self):
        return self.open()

    def __exit__(self, *args):
        self.release()