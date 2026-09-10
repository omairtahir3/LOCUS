"""
Tier-2 Asynchronous Daily Life Item Indexer.

Uses YOLO11n-Objects365 (365 daily object categories including keys, wallet,
glasses, watch, hygiene products, kitchenware, remotes, bags, etc.) to
passively catalog and index items detected in saved scene keyframes.

Runs on a dedicated background worker queue (Tier-2) completely decoupled from
the synchronous Tier-1 live camera ingest loop.
"""

from __future__ import annotations

import os
import time
import queue
import threading
import traceback
from datetime import datetime, timezone
from typing import Any, Optional

import cv2
import numpy as np

# Model path resolution
DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "models",
    "yolo11n_object365.pt"
)

# Shared singleton instance
_indexer_instance: Optional[DailyItemIndexer] = None
_indexer_lock = threading.Lock()


class DailyItemIndexer:
    """
    Asynchronous background item indexer for Memory Search & Object Retrieval.
    Processes saved keyframes without blocking video frame ingestion.
    """

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH, conf_threshold: float = 0.35):
        self.model_path = model_path
        self.conf_threshold = conf_threshold
        self._model = None
        self._model_lock = threading.Lock()
        self._queue: queue.Queue = queue.Queue(maxsize=100)
        self._is_running = True
        self._worker_thread = threading.Thread(target=self._worker_loop, daemon=True, name="DailyItemIndexerWorker")
        self._worker_thread.start()
        print(f"[DailyItemIndexer] Initialized background worker with model at {self.model_path}")

    @classmethod
    def get_instance(cls, model_path: str = DEFAULT_MODEL_PATH) -> DailyItemIndexer:
        """Thread-safe singleton accessor."""
        global _indexer_instance
        with _indexer_lock:
            if _indexer_instance is None:
                _indexer_instance = cls(model_path=model_path)
            return _indexer_instance

    def _ensure_model_loaded(self):
        """Lazy-load the YOLO11n Objects365 model."""
        if self._model is None:
            with self._model_lock:
                if self._model is None:
                    try:
                        from ultralytics import YOLO
                        print(f"[DailyItemIndexer] Loading YOLO11n-Objects365 model from {self.model_path}...")
                        t0 = time.perf_counter()
                        self._model = YOLO(self.model_path)
                        elapsed = (time.perf_counter() - t0) * 1000
                        print(f"[DailyItemIndexer] YOLO11n-Objects365 loaded successfully in {elapsed:.1f}ms (Classes: {len(self._model.names)})")
                    except Exception as e:
                        print(f"[DailyItemIndexer] ERROR: Failed to load YOLO11n-Objects365: {e}")
                        traceback.print_exc()

    def enqueue_keyframe(self, keyframe_id: str, frame: Any, metadata: dict[str, Any] | None = None) -> bool:
        """
        Enqueue a saved keyframe for background item indexing.
        Accepts numpy ndarray frame or image file path.
        Returns immediately (non-blocking).
        """
        if not keyframe_id:
            return False

        task = {
            "keyframe_id": keyframe_id,
            "frame": frame,
            "metadata": metadata or {},
            "enqueued_at": time.time()
        }

        try:
            self._queue.put_nowait(task)
            return True
        except queue.Full:
            print(f"[DailyItemIndexer] WARNING: Queue full (100 items), dropping keyframe {keyframe_id}")
            return False

    def _worker_loop(self):
        """Background worker thread loop."""
        while self._is_running:
            try:
                task = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            try:
                self._process_keyframe_task(task)
            except Exception as e:
                print(f"[DailyItemIndexer] Error processing keyframe {task.get('keyframe_id')}: {e}")
                traceback.print_exc()
            finally:
                self._queue.task_done()

    def _process_keyframe_task(self, task: dict[str, Any]):
        """Run YOLO11n-Objects365 detection on keyframe and index items to MongoDB."""
        keyframe_id = task["keyframe_id"]
        frame_input = task["frame"]
        metadata = task["metadata"]

        # Resolve image
        image = None
        if isinstance(frame_input, np.ndarray):
            image = frame_input
        elif isinstance(frame_input, str) and os.path.exists(frame_input):
            image = cv2.imread(frame_input)

        if image is None:
            # Attempt to locate from keyframe_storage on disk
            storage_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "..", "..", "keyframe_backend", "keyframe_storage"
            )
            user_id_str = str(metadata.get("user_id", "unknown"))
            today_str = datetime.now().strftime("%Y-%m-%d")
            possible_path = os.path.join(storage_dir, user_id_str, today_str, f"{keyframe_id}.jpg")
            if os.path.exists(possible_path):
                image = cv2.imread(possible_path)

        if image is None:
            print(f"[DailyItemIndexer] Could not resolve image for keyframe {keyframe_id}")
            return

        self._ensure_model_loaded()
        if self._model is None:
            return

        t0 = time.perf_counter()
        results = self._model(image, conf=self.conf_threshold, iou=0.45, verbose=False)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        if not results or len(results) == 0:
            return

        res = results[0]
        boxes = res.boxes
        if boxes is None or len(boxes) == 0:
            return

        detections = []
        orig_h, orig_w = image.shape[:2]

        for box in boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            cls_name = self._model.names.get(cls_id, f"class_{cls_id}")
            xyxy = box.xyxy[0].tolist()

            detections.append({
                "name": cls_name,
                "class_id": cls_id,
                "confidence": round(conf, 3),
                "bbox": {
                    "x1": int(max(0, xyxy[0])),
                    "y1": int(max(0, xyxy[1])),
                    "x2": int(min(orig_w, xyxy[2])),
                    "y2": int(min(orig_h, xyxy[3]))
                }
            })

        if not detections:
            return

        item_names = sorted(list(set(d["name"] for d in detections)))
        print(f"[DailyItemIndexer] Keyframe {keyframe_id}: Detected {len(detections)} items ({', '.join(item_names)}) in {elapsed_ms:.1f}ms")

        # Persist to MongoDB
        self._persist_to_db(keyframe_id, detections, item_names, metadata)

    def _persist_to_db(self, keyframe_id: str, detections: list[dict], item_names: list[str], metadata: dict):
        """Update keyframemetas and write object eventlog to MongoDB."""
        try:
            from pymongo import MongoClient
            from bson import ObjectId

            client = MongoClient("mongodb://localhost:27017")
            db = client["locusDB"]

            user_id = metadata.get("user_id")
            if not user_id:
                return

            try:
                user_oid = ObjectId(str(user_id))
            except Exception:
                user_oid = str(user_id)

            ts_now = datetime.now(timezone.utc)
            max_conf = max(d["confidence"] for d in detections)

            # 1. Update keyframemetas collection if keyframe document exists
            db.keyframemetas.update_one(
                {"keyframe_id": keyframe_id},
                {"$set": {
                    "detected_items": detections,
                    "item_names": item_names,
                    "items_indexed_at": ts_now
                }},
                upsert=False
            )

            # 2. Attach latest location if available
            location = None
            try:
                latest_loc = db.locationlogs.find_one(
                    {"user_id": user_oid},
                    sort=[("timestamp", -1)]
                )
                if latest_loc and "lat" in latest_loc and "lng" in latest_loc:
                    loc_ts = latest_loc.get("timestamp")
                    if loc_ts:
                        staleness_mins = (datetime.utcnow() - loc_ts).total_seconds() / 60.0
                        if staleness_mins <= 60.0:
                            location = {
                                "lat": latest_loc["lat"],
                                "lng": latest_loc["lng"]
                            }
            except Exception as e:
                print(f"[DailyItemIndexer] Location lookup note: {e}")

            # 3. Create searchable EventLog entry for Memory Search (Module 7)
            summary_str = f"Spotted {', '.join(item_names[:4])}"
            if len(item_names) > 4:
                summary_str += f" and {len(item_names) - 4} more"

            event_doc = {
                "user_id": user_oid,
                "event_type": "object",
                "timestamp": ts_now,
                "confidence": round(max_conf, 3),
                "details": {
                    "action": "item_seen",
                    "items": detections,
                    "item_names": item_names,
                    "summary": summary_str,
                    "total_items": len(detections)
                },
                "keyframe_id": keyframe_id,
                "verification_status": "confirmed",
                "createdAt": ts_now,
                "updatedAt": ts_now
            }

            if location:
                event_doc["location"] = location

            db.eventlogs.insert_one(event_doc)
            print(f"[DailyItemIndexer] Logged 'object' memory event for user {user_id} with {len(item_names)} items")

        except Exception as e:
            print(f"[DailyItemIndexer] DB error during persistence: {e}")
            traceback.print_exc()
