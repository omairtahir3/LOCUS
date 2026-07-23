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

# Storage lives inside keyframe_backend/keyframe_storage/
KEYFRAME_STORAGE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "keyframe_storage"
)

# Time-to-live: frames are auto-deleted after this many hours
KEYFRAME_TTL_HOURS = 72  # 3 days


class KeyframeStorage:
    """
    Persists keyframe images to disk with automatic TTL-based cleanup.
    
    Storage layout:
        keyframe_storage/
            <user_id>/
                <YYYY-MM-DD>/
                    <uuid>.jpg          — the frame image
                    <uuid>.json         — metadata (timestamp, motion_score, etc.)
    """

    def __init__(self, storage_dir=KEYFRAME_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):
        self.storage_dir = storage_dir
        self.ttl_hours = ttl_hours
        os.makedirs(self.storage_dir, exist_ok=True)



        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)

        self._cleanup_thread.start()

        print(f"[KeyframeStorage] Initialized at: {self.storage_dir}")

        

    def save(self, keyframe_id, frame, metadata):

        uid = str(metadata.get("user_id", "unknown"))

        today = datetime.now().strftime("%Y-%m-%d")

        

        user_dir = os.path.join(self.storage_dir, uid, today)

        os.makedirs(user_dir, exist_ok=True)

        img_path  = os.path.join(user_dir, f"{keyframe_id}.jpg")

        meta_path = os.path.join(user_dir, f"{keyframe_id}.json")



        success = cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 85])

        if not success:

            print(f"[KeyframeStorage] ERROR: Failed to write image to {img_path}")



        meta = {

            **metadata,

            "file": f"{keyframe_id}.jpg",

            "saved_at": datetime.now().astimezone().isoformat(),

        }

        with open(meta_path, "w") as f:

            json.dump(meta, f, indent=2)



    def load_frame(self, keyframe_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.jpg"))

        if matches: return cv2.imread(matches[0])

        legacy = os.path.join(self.storage_dir, f"{keyframe_id}.jpg")

        if os.path.exists(legacy): return cv2.imread(legacy)

        return None



    def load_metadata(self, keyframe_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.json"))

        if matches:

            with open(matches[0], "r") as f: return json.load(f)

        legacy = os.path.join(self.storage_dir, f"{keyframe_id}.json")

        if os.path.exists(legacy):

            with open(legacy, "r") as f: return json.load(f)

        return None



    def list_keyframes(self, user_id=None, medication_only=False, limit=200):

        entries = []

        try:

            user_dirs = [os.path.join(self.storage_dir, str(user_id))] if user_id else [f.path for f in os.scandir(self.storage_dir) if f.is_dir()]

            for u_dir in user_dirs:

                if not os.path.exists(u_dir): continue

                for d_dir in os.scandir(u_dir):

                    if not d_dir.is_dir(): continue

                    for entry in os.scandir(d_dir.path):

                        if entry.is_file() and entry.name.endswith('.json'):

                            try:

                                entries.append((entry.stat().st_mtime, entry.path))

                            except OSError:

                                pass

            

            # Legacy flat files

            if not user_id:

                for entry in os.scandir(self.storage_dir):

                    if entry.is_file() and entry.name.endswith('.json'):

                        try:

                            entries.append((entry.stat().st_mtime, entry.path))

                        except OSError:

                            pass

        except OSError:

            pass



        entries.sort(key=lambda x: x[0], reverse=True)



        keyframes = []

        for _mtime, meta_path in entries:

            if len(keyframes) >= limit:

                break

            try:

                with open(meta_path, "r") as f:

                    meta = json.load(f)

                    meta["keyframe_id"] = os.path.basename(meta_path).replace(".json", "")



                    if medication_only and not meta.get("medication_detected"):

                        continue

                        

                    stored_uid = meta.get("user_id", "")

                    if user_id and stored_uid and str(stored_uid) != str(user_id):

                        continue



                    keyframes.append(meta)

            except (json.JSONDecodeError, IOError):

                continue

        keyframes.sort(key=lambda k: k.get("saved_at", ""), reverse=True)

        return keyframes



    def tag_as_medication_detected(self, keyframe_id, confidence=0.0, status="taken",

                                    medication_name="", medication_id=""):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{keyframe_id}.json"))

        meta_path = matches[0] if matches else os.path.join(self.storage_dir, f"{keyframe_id}.json")

        if not os.path.exists(meta_path): return False

        try:

            with open(meta_path, "r") as f: meta = json.load(f)

            meta["medication_detected"] = True

            meta["detection_confidence"] = round(confidence, 3)

            meta["detection_status"] = status

            meta["medication_name"] = medication_name

            meta["medication_id"] = medication_id

            meta["detected_at"] = datetime.now().astimezone().isoformat()

            with open(meta_path, "w") as f: json.dump(meta, f, indent=2)

            return True

        except Exception as e:

            print(f"[KeyframeStorage] Tag error for {keyframe_id}: {e}")

            return False



    def cleanup_expired(self):

        now_utc = datetime.now(timezone.utc)

        cutoff = now_utc - timedelta(hours=self.ttl_hours)

        deleted = 0



        def _clean_json(meta_path):

            nonlocal deleted

            try:

                with open(meta_path, "r") as f: meta = json.load(f)

                saved_at = meta.get("saved_at", "")

                if not saved_at: return

                frame_time = datetime.fromisoformat(saved_at)

                if frame_time.tzinfo is None: frame_time = frame_time.astimezone(timezone.utc)

                else: frame_time = frame_time.astimezone(timezone.utc)

                if frame_time < cutoff:

                    kid = os.path.basename(meta_path).replace(".json", "")

                    img_path = os.path.join(os.path.dirname(meta_path), f"{kid}.jpg")

                    if os.path.exists(img_path): os.remove(img_path)

                    os.remove(meta_path)

                    deleted += 1

            except (json.JSONDecodeError, IOError, ValueError):

                pass



        # Clean partitioned files

        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):

            if not os.path.isdir(u_dir): continue

            for d_dir in glob.glob(os.path.join(u_dir, "*")):

                if not os.path.isdir(d_dir): continue

                # Bulk delete old date folders safely

                try:

                    folder_date = datetime.strptime(os.path.basename(d_dir), "%Y-%m-%d").replace(tzinfo=timezone.utc)

                    if folder_date < cutoff - timedelta(days=2):

                        import shutil

                        shutil.rmtree(d_dir)

                        continue

                except ValueError:

                    pass



                for meta_path in glob.glob(os.path.join(d_dir, "*.json")):

                    _clean_json(meta_path)

                    

                if not os.listdir(d_dir): os.rmdir(d_dir)



        # Clean legacy flat files

        for meta_path in glob.glob(os.path.join(self.storage_dir, "*.json")):

            _clean_json(meta_path)



        if deleted > 0:

            print(f"[KeyframeStorage] Cleaned up {deleted} expired keyframe(s)")

        return deleted



    def _cleanup_loop(self):

        while True:

            time.sleep(30 * 60)

            try: self.cleanup_expired()

            except Exception as e: print(f"[KeyframeStorage] Cleanup error: {e}")





# Evidence storage lives inside keyframe_backend/evidence_storage/

EVIDENCE_STORAGE_DIR = os.path.join(

    os.path.dirname(os.path.abspath(__file__)),

    "evidence_storage"

)





class EvidenceStorage:

    """

    Persists medicine evidence frames (Phase 1/2/3 keyframes from successful

    batch analysis detections) to disk with automatic TTL-based cleanup.

    

    Storage layout:

        evidence_storage/

            <user_id>/

                <YYYY-MM-DD>/

                    <uuid>.jpg          - the evidence frame image

                    <uuid>.json         - metadata

    """



    def __init__(self, storage_dir=EVIDENCE_STORAGE_DIR, ttl_hours=KEYFRAME_TTL_HOURS):

        self.storage_dir = storage_dir

        self.ttl_hours = ttl_hours

        os.makedirs(self.storage_dir, exist_ok=True)



        self._cleanup_thread = threading.Thread(target=self._cleanup_loop, daemon=True)

        self._cleanup_thread.start()

        print(f"[EvidenceStorage] Initialized at: {self.storage_dir}")



    def save(self, evidence_id, frame, metadata):

        uid = str(metadata.get("user_id", "unknown"))

        today = datetime.now().strftime("%Y-%m-%d")

        

        user_dir = os.path.join(self.storage_dir, uid, today)

        os.makedirs(user_dir, exist_ok=True)

        img_path  = os.path.join(user_dir, f"{evidence_id}.jpg")

        meta_path = os.path.join(user_dir, f"{evidence_id}.json")



        success = cv2.imwrite(img_path, frame, [cv2.IMWRITE_JPEG_QUALITY, 90])

        if not success:

            print(f"[EvidenceStorage] ERROR: Failed to write image {evidence_id}")



        meta = {

            **metadata,

            "file": f"{evidence_id}.jpg",

            "saved_at": datetime.now().astimezone().isoformat(),

        }

        with open(meta_path, "w") as f:

            json.dump(meta, f, indent=2)



    def load_frame(self, evidence_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{evidence_id}.jpg"))

        if matches: return cv2.imread(matches[0])

        legacy = os.path.join(self.storage_dir, f"{evidence_id}.jpg")

        if os.path.exists(legacy): return cv2.imread(legacy)

        return None



    def load_metadata(self, evidence_id):

        matches = glob.glob(os.path.join(self.storage_dir, "*", "*", f"{evidence_id}.json"))

        if matches:

            with open(matches[0], "r") as f: return json.load(f)

        legacy = os.path.join(self.storage_dir, f"{evidence_id}.json")

        if os.path.exists(legacy):

            with open(legacy, "r") as f: return json.load(f)

        return None



    def list_evidence(self, user_id=None, limit=100):

        entries = []

        try:

            user_dirs = [os.path.join(self.storage_dir, str(user_id))] if user_id else [f.path for f in os.scandir(self.storage_dir) if f.is_dir()]

            for u_dir in user_dirs:

                if not os.path.exists(u_dir): continue

                for d_dir in os.scandir(u_dir):

                    if not d_dir.is_dir(): continue

                    for entry in os.scandir(d_dir.path):

                        if entry.is_file() and entry.name.endswith('.json'):

                            try:

                                entries.append((entry.stat().st_mtime, entry.path))

                            except OSError:

                                pass

            

            if not user_id:

                for entry in os.scandir(self.storage_dir):

                    if entry.is_file() and entry.name.endswith('.json'):

                        try: entries.append((entry.stat().st_mtime, entry.path))

                        except OSError: pass

        except OSError:

            pass



        entries.sort(key=lambda x: x[0], reverse=True)



        evidence = []

        for _mtime, meta_path in entries:

            if len(evidence) >= limit: break

            try:

                with open(meta_path, "r") as f:

                    meta = json.load(f)

                    meta["evidence_id"] = os.path.basename(meta_path).replace(".json", "")



                    stored_uid = meta.get("user_id", "")

                    if user_id and stored_uid and str(stored_uid) != str(user_id):

                        continue



                    evidence.append(meta)

            except (json.JSONDecodeError, IOError):

                continue

        evidence.sort(key=lambda e: e.get("saved_at", ""), reverse=True)

        return evidence



    def cleanup_expired(self):

        now_utc = datetime.now(timezone.utc)

        cutoff = now_utc - timedelta(hours=self.ttl_hours)

        deleted = 0



        def _clean_json(meta_path):

            nonlocal deleted

            try:

                with open(meta_path, "r") as f: meta = json.load(f)

                saved_at = meta.get("saved_at", "")

                if not saved_at: return

                frame_time = datetime.fromisoformat(saved_at)

                if frame_time.tzinfo is None: frame_time = frame_time.replace(tzinfo=timezone.utc)

                if frame_time < cutoff:

                    eid = os.path.basename(meta_path).replace(".json", "")

                    img_path = os.path.join(os.path.dirname(meta_path), f"{eid}.jpg")

                    if os.path.exists(img_path): os.remove(img_path)

                    os.remove(meta_path)

                    deleted += 1

            except (json.JSONDecodeError, IOError, ValueError):

                pass



        for u_dir in glob.glob(os.path.join(self.storage_dir, "*")):

            if not os.path.isdir(u_dir): continue

            for d_dir in glob.glob(os.path.join(u_dir, "*")):

                if not os.path.isdir(d_dir): continue

                try:

                    folder_date = datetime.strptime(os.path.basename(d_dir), "%Y-%m-%d").replace(tzinfo=timezone.utc)

                    if folder_date < cutoff - timedelta(days=2):

                        import shutil

                        shutil.rmtree(d_dir)

                        continue

                except ValueError:

                    pass



                for meta_path in glob.glob(os.path.join(d_dir, "*.json")):

                    _clean_json(meta_path)

                if not os.listdir(d_dir): os.rmdir(d_dir)



        for meta_path in glob.glob(os.path.join(self.storage_dir, "*.json")):

            _clean_json(meta_path)



        if deleted > 0: print(f"[EvidenceStorage] Cleaned up {deleted} expired evidence frame(s)")

        return deleted



    def _cleanup_loop(self):

        while True:

            time.sleep(30 * 60)

            try: self.cleanup_expired()

            except Exception as e: print(f"[EvidenceStorage] Cleanup error: {e}")







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

                 blur_threshold=15.0, window_duration=1.0, top_n_per_window=5,

                 max_buffer_frames=300, user_id=""):

        self.target_fps = target_fps

        self.buffer_seconds = buffer_seconds

        self.user_id = user_id

        # Buffer holds recent frames for AI analysis.

        # Capped at max_buffer_frames to prevent memory exhaustion

        # during long sessions (e.g. 5-6 hour GoPro recording).

        # 300 frames â‰ˆ 10 seconds at 30fps â€” plenty for phase analysis.

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

        - High motion â†’ always capture

        - Low motion â†’ capture every N frames to save storage

        """

        if motion_score > self.motion_threshold:

            return True

        # Capture 1 frame per ~6 frames during low motion (saves CPU)

        return self.frame_count % 6 == 0



    def extract_keyframe(self, frame, motion_score, blur_score):

        """

        Package a frame into a keyframe record and add to in-memory buffer.

        Does NOT save to disk â€” disk persistence is handled by the

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

        Flush top 5 sharpest frames to disk in a background thread.

        Non-blocking so the camera loop never stalls on disk I/O.

        """

        if not self._window_candidates or not self.storage:

            self._window_candidates = []

            return



        # Sort by blur score (sharpest first), take top 5

        sorted_candidates = sorted(self._window_candidates, key=lambda c: c[0], reverse=True)

        to_save = sorted_candidates[:5]



        # Save in background thread so we don't block the camera loop

        def _write(candidates, storage):

            for blur_score, keyframe_id, frame, metadata in candidates:

                storage.save(keyframe_id, frame, metadata)



        t = threading.Thread(target=_write, args=(to_save, self.storage), daemon=True)

        t.start()



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

        frames to detect the pillâ†’gripâ†’gone sequence.

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

        Main method â€” call for every frame from the camera.



        1. ALL frames go into in-memory buffer for AI analysis.

        2. Frames are saved to disk every 1-second window.



        Optimized: blur score only computed every 3rd frame,

        motion uses downscaled comparison, disk writes are async.

        """

        self.frame_count += 1

        if self.frame_count % 100 == 0:

            print(f"[KeyframeExtractor] Processed {self.frame_count} frames... (Buffer: {len(self.buffer)})")



        # Fast motion check: use downscaled grayscale (4x smaller)

        small = cv2.resize(frame, (frame.shape[1] // 4, frame.shape[0] // 4))

        gray_small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

        if self.prev_frame is None:

            self.prev_frame = gray_small

            motion_score = 0

        else:

            diff = cv2.absdiff(self.prev_frame, gray_small)

            motion_score = float(np.mean(diff))

            self.prev_frame = gray_small



        # Blur score: only compute every 3rd frame (Laplacian is expensive)

        if self.frame_count % 3 == 0:

            blur_score = self.compute_blur_score(frame)

            self._last_blur_score = blur_score

        else:

            blur_score = getattr(self, '_last_blur_score', 100.0)



        keyframe_id = str(uuid.uuid4())

        timestamp = datetime.now().astimezone().isoformat()



        # 1. Disk: collect candidates, flush every window_duration seconds

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

            # Only keep top_n candidates in memory (avoid frame.copy for every frame)

            if len(self._window_candidates) < self.top_n_per_window:

                self._window_candidates.append((blur_score, keyframe_id, frame.copy(), metadata))

            else:

                # Replace worst candidate if this frame is sharper

                worst_idx = min(range(len(self._window_candidates)), key=lambda i: self._window_candidates[i][0])

                if blur_score > self._window_candidates[worst_idx][0]:

                    self._window_candidates[worst_idx] = (blur_score, keyframe_id, frame.copy(), metadata)



            # Flush when window_duration of wall-clock time has passed

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

            # Optimize OpenCV for RTMP/RTSP streams

            if isinstance(self.source, str) and ("rtmp://" in self.source or "rtsp://" in self.source):

                import os

                # Force TCP transport for RTSP to prevent H264 decode errors

                # from UDP packet loss. Increase probesize for stable stream init.

                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (

                    "rtsp_transport;tcp|fflags;nobuffer|analyzeduration;1000000|probesize;1000000"

                )

                

            self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)

            if getattr(cv2, 'CAP_PROP_BUFFERSIZE', None) is not None:

                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)



            # Retry for RTSP/RTMP streams â€” the publisher (GoPro) may not be live yet

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

            while not getattr(self, '_new_frame', False) and self._running and timeout < 1000:

                time.sleep(0.005)

                timeout += 1

                

            if not getattr(self, '_new_frame', False):

                return False, None

            

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