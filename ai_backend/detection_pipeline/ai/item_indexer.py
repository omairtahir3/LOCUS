"""
Tier-2 Asynchronous Daily Life Item Indexer & Activity Enrichment Engine.

Uses YOLO11n-Objects365 (365 daily object categories including keys, wallet,
glasses, watch, hygiene products, kitchenware, remotes, bags, etc.) to:
1. Passively catalog and index personal items detected in saved scene keyframes (Memory Search).
2. Perform Tier-2 Gap-Filling Enrichment for activities that Tier-1 (COCO 80 classes)
   cannot see (e.g., Plate -> Eating, Pot/Kettle -> Cooking, Toothbrush -> Brushing teeth, Soap -> Washing hands).

Runs on a dedicated background worker queue (Tier-2) completely decoupled from
the synchronous Tier-1 live camera ingest loop.
"""

from __future__ import annotations

import os
import re
import time
import queue
import threading
import traceback
from datetime import datetime, timezone
from typing import Any, Optional

import cv2
import numpy as np
from db_config import get_client, get_db_name

# Model path resolution
DEFAULT_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "models",
    "yolo11n_object365.pt"
)

# Personal belongings and handheld/wearable items only.
# Static appliances, furniture, fixtures, and sports equipment are excluded.
# Tier-2 Gap-Fill triggers (Gas stove, Coffee Machine, etc.) are kept because
# the enrichment engine needs them detected to infer activities.
PERSONAL_ITEM_CLASS_IDS = {
    # ── Footwear ──
    1: "Sneakers",
    3: "Other Shoes",
    22: "Leather Shoes",
    29: "Boots",
    45: "Slippers",
    51: "Sandals",
    57: "High Heels",
    # ── Accessories / Jewelry ──
    4: "Hat",
    7: "Glasses",
    4: "Hat",
    14: "Bracelet",
    32: "Necklace",
    33: "Ring",
    36: "Belt",
    42: "Watch",
    43: "Tie",
    44: "Cap",
    151: "Bow Tie",
    17: "Helmet",
    208: "Mask",
    # ── Bags / Carry ──
    13: "Handbag/Satchel",
    38: "Backpack",
    39: "Umbrella",
    120: "Luggage",
    194: "Briefcase",
    # ── Electronics ──
    61: "Cell Phone",
    63: "Camera",
    73: "Laptop",
    106: "Keyboard",
    115: "Mouse",
    123: "Telephone",
    125: "Head Phone",
    207: "earphone",
    132: "Remote",
    243: "Tablet",
    316: "Calculator",
    # ── Personal Care / Hygiene ──
    105: "Toiletry",
    226: "Toothbrush",           # Tier-2 Gap-Fill (Brushing teeth)
    293: "Soap",                 # Tier-2 Gap-Fill (Washing hands)
    328: "Hair Dryer",           # Tier-2 Gap-Fill (Drying hair)
    351: "Comb",                 # Tier-2 Gap-Fill (Grooming)
    256: "Brush",
    244: "Cosmetics",
    355: "Cosmetics Brush/Eyeliner Pencil",
    361: "Lipstick",
    362: "Cosmetics Mirror",
    69: "Towel",                 # Tier-2 Gap-Fill (Drying/Hygiene)
    225: "Tissue",
    # ── Kitchen / Eating (Tier-2 Gap-Fill triggers) ──
    8: "Bottle",
    10: "Cup",
    15: "Plate",                 # Tier-2 Gap-Fill (Eating)
    26: "Bowl/Basin",
    84: "Knife",                 # Tier-2 Gap-Fill (Eating/Cooking)
    88: "Fork",                  # Tier-2 Gap-Fill (Eating)
    93: "Spoon",                 # Tier-2 Gap-Fill (Eating)
    95: "Pot",                   # Tier-2 Gap-Fill (Cooking)
    122: "Tea pot",              # Tier-2 Gap-Fill (Drinking/Cooking)
    140: "Jug",                  # Tier-2 Gap-Fill (Drinking)
    149: "Gas stove",            # Tier-2 Gap-Fill (Cooking)
    166: "Cutting/chopping Board",# Tier-2 Gap-Fill (Cooking)
    169: "Scissors",
    203: "Tong",
    209: "Kettle",               # Tier-2 Gap-Fill (Cooking/Drinking)
    213: "Coffee Machine",       # Tier-2 Gap-Fill (Drinking)
    268: "Induction Cooker",     # Tier-2 Gap-Fill (Cooking)
    290: "Flask",
    # ── Stationery / Office ──
    18: "Book",
    54: "Pen/Pencil",
    170: "Marker",
    205: "Folder",
    281: "Notepaper",
    343: "Pencil Case",
    357: "Eraser",
    306: "Stapler",
    242: "Tape",
    # ── Valuables / Keys ──
    238: "Wallet/Purse",
    251: "Key",
    332: "Lighter",
    # ── Misc Personal ──
    19: "Gloves",
    70: "Stuffed Toy",
}

# Tier-2 Gap-Filling Mapping: Objects365 Class ID -> (activity_name, default_environment)
# Triggered when Tier-1 (YOLOv8 COCO) could not detect an activity or was structurally blind to the object class.
TIER2_GAP_FILL_ACTIVITY_MAP: dict[int, tuple[str, str]] = {
    15: ("eating", "dining area"),          # Plate (Missing in COCO)
    88: ("eating", "dining area"),          # Fork
    93: ("eating", "dining area"),          # Spoon
    84: ("eating", "dining area"),          # Knife
    95: ("cooking", "kitchen"),             # Pot
    122: ("drinking", "kitchen"),           # Tea pot
    140: ("drinking", "kitchen"),           # Jug
    149: ("cooking", "kitchen"),            # Gas stove
    166: ("cooking", "kitchen"),            # Cutting/chopping Board
    209: ("cooking", "kitchen"),            # Kettle
    213: ("drinking", "kitchen"),           # Coffee Machine
    226: ("brushing teeth", "bathroom"),    # Toothbrush
    268: ("cooking", "kitchen"),            # Induction Cooker
    293: ("washing hands", "bathroom"),     # Soap
    328: ("drying hair", "bathroom"),       # Hair Dryer
    351: ("grooming", "bathroom"),          # Comb
}

# Tier-2 gap-fill activities that describe the wearer EATING or DRINKING assert
# an action, not a scene. A Plate sitting on a table at conf 0.77 cleared the
# 0.55 gate and logged "Eating in the dining area." while the wearer was typing.
# Mirror Tier-1's HANDHELD_REQUIRED rule: these triggers must also be close
# enough to the camera to plausibly be held. Structural/appliance triggers
# (stove, kettle, coffee machine) are exempt -- their presence genuinely does
# describe the scene and they are never held.
# Tier-2 gap-fill activity synthesis is retired; environment sessions replace it.
# Flip to True to restore the old behaviour for comparison.
EMIT_TIER2_GAP_FILL_ACTIVITY = False

TIER2_HANDHELD_ACTIVITIES = {"eating", "drinking"}
TIER2_HANDHELD_MIN_AREA_FRAC = 0.04

# ── Outdoor handling ──────────────────────────────────────────────────────────
# Age limit on the GPS fix attached to an item sighting. That fix is what
# "last seen at" shows if the item goes missing, so it has to be from roughly
# the moment of the sighting, not from whenever the phone last reported.
ITEM_LOCATION_MAX_STALENESS_MIN = 10.0

# Candidate-detection confidence used when the wearer is outdoors. Variable
# lighting and busy backgrounds depress YOLO's box confidence on the same
# object, so the candidate bar drops from 0.30 to 0.25. The EXEMPLAR threshold
# is deliberately NOT loosened: Option B still requires an identity match at
# 0.74 for anything to persist, so this widens what gets looked at without
# widening what gets believed. UNVALIDATED -- no outdoor footage exists yet;
# 0.25 is the value the earlier candidate sweep showed recovers boxes without
# a false-positive cost indoors.
#
# "Outdoors" is decided from GPS, not vision: the latest trustworthy fix is
# further from the user's home_location than GPS noise allows. Same thresholds
# as the Node monitor (utils/outdoor.js) so both sides agree. Nothing about the
# environment is classified or logged; this only tunes item detection.
OUTDOOR_CONF_THRESHOLD = 0.25
OUTDOOR_HOME_RADIUS_M = 150.0
OUTDOOR_MAX_FIX_ACCURACY_M = 100.0
OUTDOOR_MAX_FIX_AGE_MIN = 10.0
OUTDOOR_STATUS_CACHE_S = 60.0     # one DB lookup per user per minute, not per keyframe

# Items are persistent in a way activities are not — a wallet left on a desk
# stays in frame for hours, so a 15-minute window prevents keyframe flooding
# while re-indexing items when re-encountered. Suppression is per (user, item
# identity), so distinct belongings track independent windows.
#
# Briefly reduced to 120s on the theory that the window was hiding repeat
# sightings of the wearer's car keys. That diagnosis was wrong: the keys were
# missing because a deduped Phone match skipped the tile scan entirely (see the
# has_fresh_match gate in _process_keyframe_task), and the gap since the
# previous keys event was 4205s — far outside any window. With the real cause
# fixed, 900s is restored; at 120s the same keys logged twice in two minutes,
# which is the flooding this gate exists to prevent.
ITEM_DEDUP_SECONDS = 900  # 15 minutes

# ── Held, or put down? ──────────────────────────────────────────────────────
#
# A memory aid does not need to tell somebody they are holding their phone;
# they can see that. What it needs to record is the moment the phone stopped
# being in their hand, because that is the fact they will want back later: not
# "you have your keys" but "you put your keys on the hall table at 4pm".
#
# The test is the wearer's own hands, via the MediaPipe detector the medication
# pipeline already runs. This is not a proxy: if a hand box overlaps the item,
# or a fingertip is beside it, the item is in hand. Bounding-box area was tried
# first and rejected: across the enrolled sightings actually recorded, held and
# put-down items both span 1.6% to 6.7% of frame, so area cannot separate them.
# Area survives only as a backstop for an item filling the view, which is at
# the camera and cannot be across the room.
ITEM_HELD_OVERLAP_FRAC = float(os.environ.get("ITEM_HELD_OVERLAP_FRAC", 0.15))
ITEM_HELD_NEAR_FRAC = float(os.environ.get("ITEM_HELD_NEAR_FRAC", 0.06))
ITEM_HELD_MAX_AREA_FRAC = float(os.environ.get("ITEM_HELD_MAX_AREA_FRAC", 0.30))

# When the hand detector is unavailable, every sighting is treated as put down
# rather than dropped. Losing the record entirely is the worse failure: a
# missing "where did I leave it" is the thing this feature exists to prevent.
LOG_ONLY_PLACED_ITEMS = os.environ.get(
    "LOG_ONLY_PLACED_ITEMS", "1").lower() not in ("0", "false", "no")

# Indexing runs behind a queue and three models, so a frame can be processed
# well after it was taken. Above this backlog the tile scan is skipped: it is
# the single most expensive step (about 100 MobileNetV3 crops, ~975ms measured)
# and it exists to catch small items YOLO cannot box. Under load, keeping up
# with the stream matters more than finding every set of keys, and falling
# further behind delays every memory after this one too.
TILE_SCAN_MAX_BACKLOG = int(os.environ.get("TILE_SCAN_MAX_BACKLOG", 3))


def _confidences(detections: list[dict]) -> tuple[list[float], list[float]]:
    """Split a frame's detections into identity and class confidences.

    Two different questions, and they come apart badly. A real sighting of the
    wearer's phone was written with confidence 0.319 and shown to them as "32%",
    while the exemplar match behind it scored 0.755 and had cleared even the
    original 0.74 bar. 0.319 answers "is that shape a phone"; 0.755 answers "is
    that the phone we were told about". A record that says "Left Phone here" is
    making the second claim, so that is the number it must carry.
    """
    identity = [d["exemplar_similarity"] for d in detections
                if d.get("exemplar_similarity") is not None]
    cls = [d["confidence"] for d in detections if d.get("confidence") is not None]
    return identity, cls


def _parse_ts(value):
    """Parse the capture timestamp the pipeline passes in metadata.

    Returns a timezone-aware datetime, or None when there is nothing usable.
    Naive values are assumed to be UTC, matching how the pipeline writes them.
    """
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str) and value:
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    elif isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    else:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)

# ── Tiled exemplar scan ───────────────────────────────────────────────────────
# Objects365 cannot box small personal items: across 6 real chest-cam frames it
# produced a box on the wearer's car keys 0/6 times, and a sweep of imgsz
# (640/960/1280) x conf (0.30/0.15/0.05) produced ZERO "Key" boxes in 36 runs.
# The exemplar gallery, given the correct crop, scores those same keys 0.653-0.823
# against a 0.65 threshold and ranks them #1 in 6/6 -- so the matcher works and
# only candidate generation was failing. This scans the frame directly.
#
# Measured on those 6 frames (keys found / false positives / cost):
#   YOLO allowlist only (before)      0/6   1 FP    7 crops
#   class-agnostic conf 0.10          2/6   1 FP   17 crops
#   tiles [120,200,320] stride 0.60   5/6   0 FP  121 regions  2765ms
#   tiles [120,200]     stride 0.75   5/6   0 FP  100 regions   975ms  <-- shipped
# Tile sizes are fractions of frame width so they hold at other resolutions.
TILE_SCALE_FRACS = (0.094, 0.156)   # ~120px and ~200px at 1280 wide
TILE_STRIDE_FRAC = 0.75             # stride as a fraction of tile size
TILE_REGION_X = (0.05, 0.95)        # horizontal search bounds
# 0.10, not the 0.30 "lower-centre interactive zone" the YOLO path assumes: when
# the wearer reclines, the sofa surface rises into the upper half and the keys
# landed at y=85-150. At y0=0.30 that frame was unreachable and scored 4/6; at
# 0.10 it is found at sim=0.825 for 5/6, still 0 false positives, ~100 regions.
TILE_REGION_Y0 = 0.10
TILE_MIN_PX = 20

# How long an unenrolled sighting stays in the suggestion queue before MongoDB
# expires it. Long enough that the user sees it next time they open the
# enrollment screen; short enough that unattributed sightings never accumulate
# as permanent history.
SUGGESTION_TTL_SECONDS = 48 * 3600

# Minimum trigger confidence before Tier-2 may synthesise an activity.
# Matches Tier-1's weakest real tier (0.55) so the gap-filler can't assert
# activities at confidences Tier-1 would have rejected outright.
TIER2_MIN_ACTIVITY_CONF = 0.55

# Shared singleton instance
_indexer_instance: Optional[DailyItemIndexer] = None
_indexer_lock = threading.Lock()


class DailyItemIndexer:
    """
    Asynchronous background item indexer for Memory Search & Tier-2 Activity Gap-Filling.
    Processes saved keyframes without blocking video frame ingestion.

    Exemplar Embedding Gallery:
    After YOLO detects items, each bounding box crop is run through MobileNetV3-Small
    and matched against the user's enrolled item embeddings (cosine similarity ≥ 0.75).
    This personalizes detections from generic class labels ("Key") to user-specific names
    ("Omair's silver house keys").
    """

    # Minimum cosine similarity to consider an embedding match.
    #
    # 0.65 -> 0.70 -> 0.74, each step driven by a production false positive.
    # Every tile-scan match observed, with the frame checked by eye:
    #     TRUE  0.752 0.753 0.758 0.758 0.783 0.799 0.800 0.825
    #           (keys visibly on the sofa or the table)
    #     FALSE 0.714  a 120px tile of a black office chair, in a bedroom the
    #                  keys were never in
    #           0.664  a patch of sofa and laptop edge
    #           0.663  a mouse matched to "Phone"
    # 0.74 sits in the gap between the highest false (0.714) and the lowest
    # true (0.752). Texture was tried first as a discriminator and rejected:
    # Laplacian variance ran 556-957 on true tiles and 459-1294 on false ones,
    # fully overlapping.
    #
    # The cost is recall on marginal sightings (0.706-0.719 matches are no
    # longer logged). That is the right trade here: the 15-minute dedup means
    # only one sighting per window is recorded anyway, so a weak match is
    # usually redundant with a strong one, while a false "you had your keys"
    # is actively misleading in a memory aid.
    EXEMPLAR_MATCH_THRESHOLD = 0.74

    # A lower bar, used ONLY when YOLO boxed the object and the class it named
    # agrees with the enrolled item ("Cell Phone" for an item called "Phone").
    #
    # Every false positive behind the 0.74 figure above was a TILE-SCAN match
    # with a class that did not agree, including the mouse that matched "Phone"
    # at 0.663. The class-agreeing YOLO path has produced no observed false
    # positive at all, so it is the one place the bar can come down without
    # giving up what 0.74 bought.
    #
    # It needs to come down because 0.74 is not reachable for every item. The
    # wearer's phone was matched once, at 0.741, having cleared the bar by
    # 0.001; its four enrolment photos agree with each other at a mean of only
    # 0.699, so most views of it score below the threshold and are dropped. An
    # item cannot be required to match a stranger's view of it more closely
    # than its own reference photos match each other.
    #
    # The trade is explicit: a different phone of the same model, boxed as a
    # Cell Phone, could now be reported as this person's phone. In a memory aid
    # that is a much smaller harm than never recording the phone at all, and
    # tile scans, which is where the false positives actually came from, are
    # unaffected and still require 0.74.
    CLASS_AGREE_MATCH_THRESHOLD = 0.65
    # How often (seconds) to refresh the user_items cache from MongoDB
    EXEMPLAR_CACHE_TTL = 300  # 5 minutes

    @staticmethod
    def _names_agree(class_name: str, item_name: str) -> bool:
        """Does the detected class plausibly describe the enrolled item?

        Token overlap after crude singularisation, so "Cell Phone" agrees with
        "Phone" and "Key" with "Car Keys", while "Mouse" agrees with neither.
        """
        def tokens(s):
            return {
                w[:-1] if len(w) > 3 and w.endswith("s") else w
                for w in re.findall(r"[a-z]+", str(s).lower())
                if len(w) > 2 and w not in {"the", "and", "his", "her", "for"}
            }
        return bool(tokens(class_name) & tokens(item_name))

    def __init__(self, model_path: str = DEFAULT_MODEL_PATH, conf_threshold: float = 0.30):
        self.model_path = model_path
        self.conf_threshold = conf_threshold
        self._model = None
        self._model_lock = threading.Lock()
        self._queue: queue.Queue = queue.Queue(maxsize=100)
        self._last_item_seen: dict[tuple[str, int], float] = {}  # (user, class_id) -> monotonic ts
        self._last_enriched_activity: dict[tuple[str, str], float] = {}  # (user, activity) -> monotonic ts
        self._is_running = True

        # Exemplar Gallery: embedding backbone + user_items cache
        self._embedding_backbone = None
        self._user_items_cache: dict[str, tuple[float, list[dict]]] = {}  # user_id -> (timestamp, items)
        self._scene_trackers: dict[str, Any] = {}   # user_id -> SceneSessionTracker
        self._db_client = None

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
                        # A misspelled scene weight key can never fire and is
                        # otherwise completely silent. Check once, here, where
                        # the real class list is finally available.
                        try:
                            from ai.scene import validate_against_model
                            validate_against_model(self._model.names)
                        except Exception:
                            pass
                    except Exception as e:
                        print(f"[DailyItemIndexer] ERROR: Failed to load YOLO11n-Objects365: {e}")
                        traceback.print_exc()

    def enqueue_keyframe(self, keyframe_id: str, frame: Any, metadata: dict[str, Any] | None = None) -> bool:
        """
        Enqueue a saved keyframe for background item indexing and Tier-2 enrichment.
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
        """Run YOLO11n-Objects365 detection on keyframe and index items / enrich activity."""
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
        # FE-14: loosen the candidate bar when GPS says the wearer is outdoors.
        _uid = str((metadata or {}).get("user_id", ""))
        _conf = OUTDOOR_CONF_THRESHOLD if self._is_outdoors_gps(_uid) else self.conf_threshold
        results = self._model(image, conf=_conf, iou=0.45, verbose=False)
        elapsed_ms = (time.perf_counter() - t0) * 1000

        if not results or len(results) == 0:
            return

        res = results[0]
        boxes = res.boxes
        if boxes is None or len(boxes) == 0:
            return

        detections = []
        scene_detections: dict[str, float] = {}
        orig_h, orig_w = image.shape[:2]

        for box in boxes:
            cls_id = int(box.cls[0].item())
            # Scene classification needs every class, not just personal items:
            # a Refrigerator identifies a kitchen and is not a belonging.
            _cn = self._model.names.get(cls_id, "")
            _cf = float(box.conf[0].item())
            if _cn and _cf >= 0.25:
                scene_detections[_cn] = max(scene_detections.get(_cn, 0.0), _cf)
            # Personal belongings & activity objects only
            if cls_id not in PERSONAL_ITEM_CLASS_IDS:
                continue
            conf = float(box.conf[0].item())
            if conf < _conf:   # same bar as the inference call (outdoor-aware)
                continue
            cls_name = self._model.names.get(cls_id, f"class_{cls_id}")
            xyxy = box.xyxy[0].tolist()

            # Position-based proximity proxy (lower-center interactive zone):
            # In chest/head-worn egocentric view, items held or in front of the wearer:
            # 1. Fall within horizontal central field of view (0.10 <= cx <= 0.90)
            # 2. Reside in the lower interactive half (center_y >= 0.48 or base y2 >= 0.58)
            # This rejects distant background items (e.g. distant bottles at cy=0.40-0.45, y2=0.55)
            # while preserving small in-hand belongings (keys, mouse, phone, ring, plate).
            norm_cx = ((xyxy[0] + xyxy[2]) / 2.0) / orig_w
            norm_cy = ((xyxy[1] + xyxy[3]) / 2.0) / orig_h
            norm_y2 = float(xyxy[3]) / orig_h
            if not (0.10 <= norm_cx <= 0.90 and (norm_cy >= 0.38 or norm_y2 >= 0.45)):
                continue

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

        # ── Environment session tracking ─────────────────────────────────────
        # Runs on every keyframe, before any item-related early return: the room
        # the wearer is in does not depend on whether they own anything in view.
        user_id_str = str((metadata or {}).get("user_id", ""))
        self._observe_scene(scene_detections, user_id_str, keyframe_id, metadata)

        # ── Exemplar Embedding Gallery: match detections against enrolled items ──
        if detections and user_id_str:
            self._enrich_with_exemplar_matches(detections, image, user_id_str)

        # Objects365 cannot box small personal items -- it boxed the wearer's car
        # keys in 0 of 6 real frames, including one where they filled a third of
        # the view -- so the frame is scanned directly for anything the YOLO path
        # did not already find.
        #
        # Scanned PER ITEM, not per frame. Two earlier versions gated the whole
        # scan on the frame as a unit and both lost items: skipping when any
        # match existed meant a deduped Phone hid the car keys entirely, and
        # skipping when any FRESH match existed meant a Phone the wearer really
        # was holding did the same. Each enrolled belonging is independent, so
        # the scan now looks only for the ones this frame has not accounted for.
        if user_id_str:
            already_matched = {
                d.get("enrolled_item_id") for d in detections if d.get("matched_item")
            }
            enrolled_ids = {it["id"] for it in self._get_user_items_cached(user_id_str)}
            backlog = self._queue.qsize()
            if enrolled_ids - already_matched:
                if backlog > TILE_SCAN_MAX_BACKLOG:
                    # Shedding the expensive step rather than the frame. Running
                    # it here would push every queued frame further behind, and
                    # the lag is what the wearer actually notices.
                    print(f"[DailyItemIndexer] {backlog} frames queued, skipping the "
                          f"tile scan to catch up")
                else:
                    detections.extend(self._scan_tiles_for_enrolled_items(
                        image, user_id_str, exclude_item_ids=already_matched))

        if not detections:
            return

        # ── Held items are not memories ──────────────────────────────────────
        # Applied BEFORE the dedup gate on purpose. If a held sighting were
        # allowed through, it would claim the item's 15-minute slot and the
        # moment the wearer actually put it down would be suppressed as a
        # duplicate -- turning the one sighting worth keeping into the one
        # sighting dropped.
        hand_boxes = self._hand_boxes(image) if detections else None
        img_h, img_w = image.shape[:2]
        if detections and LOG_ONLY_PLACED_ITEMS and hand_boxes is not None:
            kept = []
            for d in detections:
                if self._is_held(d["bbox"], hand_boxes, img_w, img_h):
                    print(f"[DailyItemIndexer] {d.get('matched_item', d['name'])} is in "
                          f"hand, not recorded as put down")
                    continue
                d["placement"] = "placed"
                kept.append(d)
            detections = kept
            if not detections:
                return
        else:
            for d in detections:
                # Recorded honestly: we did not look, so we do not claim.
                d["placement"] = "unknown" if hand_boxes is None else "placed"

        # Tier-2 Gap-Filling Activity Enrichment
        self._check_and_enrich_activity(keyframe_id, detections, metadata, image.shape[:2])

        # ── Item Deduplication Gate ──────────────────────────────────────────
        # Design Specification:
        # 1. ENROLLED items: Dedup key is (user_id, enrolled_item_id).
        #    Each custom enrolled item tracks its own independent 15-minute window,
        #    allowing distinct belongings (e.g., "House Keys" vs "Car Keys") to be
        #    indexed separately even if they share the same base YOLO category.
        # 2. UNENROLLED items: Dedup key falls back to (user_id, class_id).
        #    Generic unenrolled items collapse into a single per-class dedup bucket
        #    (an accepted design limitation since unenrolled objects lack unique signatures).
        user_key = str((metadata or {}).get("user_id", "unknown"))
        now_ts = time.monotonic()
        fresh = []
        suppressed = []
        for d in detections:
            item_identity = d.get("enrolled_item_id") or d["class_id"]
            k = (user_key, item_identity)
            last = self._last_item_seen.get(k)
            if last is None or (now_ts - last) >= ITEM_DEDUP_SECONDS:
                self._last_item_seen[k] = now_ts
                fresh.append(d)
            else:
                suppressed.append(d.get("matched_item", d["name"]))

        if not fresh:
            # All items suppressed within dedup window (zero disk writes, zero DB inserts)
            return

        detections = fresh

        # ── Option B: identity-gated persistence ─────────────────────────────
        # Only detections matched to a specifically enrolled item become
        # permanent records. Generic allowlist detections cannot be attributed
        # to a known belonging, so persisting them produced 174 unattributed
        # rows against 0 matched ones. They now go to a short-TTL suggestion
        # queue instead, surfacing as "we noticed an unenrolled wallet" on the
        # enrollment screen and expiring on their own.
        matched = [d for d in detections if d.get("matched_item")]
        unmatched = [d for d in detections if not d.get("matched_item")]

        if unmatched:
            self._write_enrollment_suggestions(unmatched, metadata)

        if not matched:
            names = sorted(set(d["name"] for d in unmatched))
            print(f"[DailyItemIndexer] No enrolled-item match; {len(unmatched)} "
                  f"detection(s) routed to suggestions ({', '.join(names)})")
            return

        detections = matched
        item_names = sorted(list(set(d.get("matched_item", d["name"]) for d in detections)))
        extra = f" [suppressed: {', '.join(sorted(set(suppressed)))}]" if suppressed else ""
        matched_count = len(matched)
        match_str = f" ({matched_count} exemplar-matched)" if matched_count else ""

        # ── Persist Item Keyframe Evidence into items_storage/ ──
        import uuid
        item_keyframe_id = str(uuid.uuid4())
        try:
            storage = self._get_item_storage()
            if storage is not None:
                storage.save(item_keyframe_id, image, {
                    **(metadata or {}),
                    "user_id": user_key,
                    "type": "item_detection",
                    "items": item_names,
                    "matched_count": matched_count
                })
        except Exception as e:
            print(f"[DailyItemIndexer] Error saving item evidence keyframe: {e}")

        print(f"[DailyItemIndexer] Keyframe {item_keyframe_id}: Detected {len(detections)} items ({', '.join(item_names)}){match_str} in {elapsed_ms:.1f}ms{extra}")

        # Persist to MongoDB referencing the exact item_keyframe_id
        self._persist_to_db(item_keyframe_id, detections, item_names, metadata)

    def _get_item_storage(self):
        """Lazy-load the ItemStorage for persisting item detection keyframes."""
        if not hasattr(self, "_item_storage") or self._item_storage is None:
            try:
                from keyframe_backend.keyframe import ItemStorage
                self._item_storage = ItemStorage()
            except ImportError:
                import sys, os
                kb_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "keyframe_backend"))
                if kb_dir not in sys.path:
                    sys.path.insert(0, kb_dir)
                from keyframe_backend.keyframe import ItemStorage
                self._item_storage = ItemStorage()
        return self._item_storage

    def _write_enrollment_suggestions(self, unmatched: list[dict], metadata: dict):
        """Record unenrolled sightings in a short-TTL suggestion queue.

        Expiry is a MongoDB TTL index on `expires_at` rather than a cleanup
        thread, so the database enforces it and there is no extra worker to own.
        """
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            from datetime import timedelta

            user_id = (metadata or {}).get("user_id")
            if not user_id:
                return

            client = get_client()
            db = client[get_db_name()]
            self._ensure_suggestion_ttl_index(db)

            now = datetime.now(timezone.utc)
            expires = now + timedelta(seconds=SUGGESTION_TTL_SECONDS)
            try:
                uid = ObjectId(str(user_id))
            except Exception:
                uid = str(user_id)

            for d in unmatched:
                # One live suggestion per (user, class): re-seeing the same
                # unenrolled object refreshes its expiry instead of stacking.
                db.item_suggestions.update_one(
                    {"user_id": uid, "class_id": d["class_id"]},
                    {"$set": {
                        "user_id": uid,
                        "class_id": d["class_id"],
                        "item_name": d["name"],
                        "confidence": d.get("confidence"),
                        "last_seen": now,
                        "expires_at": expires,
                    },
                     "$inc": {"sighting_count": 1},
                     "$setOnInsert": {"created_at": now}},
                    upsert=True,
                )
        except Exception as e:
            print(f"[DailyItemIndexer] Error writing enrollment suggestions: {e}")

    @staticmethod
    def _ensure_suggestion_ttl_index(db):
        """Create the TTL index once; MongoDB then expires documents itself."""
        try:
            existing = db.item_suggestions.index_information()
            if not any(i.get("expireAfterSeconds") is not None for i in existing.values()):
                db.item_suggestions.create_index("expires_at", expireAfterSeconds=0)
                print("[DailyItemIndexer] Created TTL index on item_suggestions.expires_at")
        except Exception as e:
            print(f"[DailyItemIndexer] Could not ensure suggestion TTL index: {e}")

    def _get_embedding_backbone(self):
        """Lazy-load the MobileNetV3-Small embedding backbone."""
        if self._embedding_backbone is None:
            try:
                from ai.embedding_backbone import ItemEmbeddingBackbone
                self._embedding_backbone = ItemEmbeddingBackbone.get_instance()
            except Exception as e:
                print(f"[DailyItemIndexer] Error loading embedding backbone: {e}")
        return self._embedding_backbone

    def _get_user_items_cached(self, user_id_str: str) -> list[dict]:
        """
        Fetch active enrolled items with embeddings for a given user from MongoDB.
        Caches results in memory for EXEMPLAR_CACHE_TTL seconds.
        """
        now = time.monotonic()
        cached = self._user_items_cache.get(user_id_str)
        if cached is not None:
            cached_time, items = cached
            if now - cached_time < self.EXEMPLAR_CACHE_TTL:
                return items

        # Query MongoDB
        items = []
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            if self._db_client is None:
                self._db_client = get_client(serverSelectionTimeoutMS=2000)
            db = self._db_client[get_db_name()]

            try:
                user_oid = ObjectId(user_id_str)
                query = {"user_id": user_oid, "is_active": True}
            except Exception:
                query = {"user_id": user_id_str, "is_active": True}

            cursor = db.useritems.find(query, {"item_name": 1, "item_embeddings": 1})
            for doc in cursor:
                embs = doc.get("item_embeddings", [])
                if embs:
                    embs_arr = [np.array(e, dtype=np.float32) for e in embs if len(e) == 576]
                    # Adaptive threshold: if multi-angle internal similarity is very high (>= 0.96),
                    # the item lacks high-frequency surface texture (e.g. plain solid surface).
                    # For such items, apply a cautious 0.72 threshold to prevent ambient clutter false matches.
                    if len(embs_arr) >= 2:
                        pairwise = [
                            float(np.dot(embs_arr[i], embs_arr[j]))
                            for i in range(len(embs_arr))
                            for j in range(i + 1, len(embs_arr))
                        ]
                        mean_internal_sim = sum(pairwise) / len(pairwise) if pairwise else 1.0
                    else:
                        mean_internal_sim = 1.0

                    item_thresh = 0.72 if mean_internal_sim >= 0.96 else self.EXEMPLAR_MATCH_THRESHOLD

                    items.append({
                        "id": str(doc["_id"]),
                        "name": doc.get("item_name", "Unknown Item"),
                        "embeddings": embs_arr,
                        "threshold": item_thresh
                    })
        except Exception as e:
            print(f"[DailyItemIndexer] Error fetching user items for {user_id_str}: {e}")

        self._user_items_cache[user_id_str] = (now, items)
        return items

    def _enrich_with_exemplar_matches(self, detections: list[dict], image: np.ndarray, user_id_str: str):
        """
        Exemplar Matching:
        For each YOLO-detected personal item, crop the bounding box, extract a 576-D embedding,
        and compare it against the user's enrolled item embeddings.
        If max cosine similarity >= item threshold (0.65 for textured items, 0.72 for plain items),
        rename the detection to the user's custom name.
        """
        user_items = self._get_user_items_cached(user_id_str)
        if not user_items:
            return

        backbone = self._get_embedding_backbone()
        if backbone is None:
            return

        img_h, img_w = image.shape[:2]

        # Collect every crop first, then embed them in ONE batched forward pass.
        # Embedding was the dominant cost in the worker: measured 109ms/crop when
        # extract() was called per detection in a loop, vs 61ms/crop through
        # extract_batch() on the same 8 crops (1.8x). A typical keyframe yields
        # 2-5 allowlisted boxes, so this removes ~100-250ms per keyframe.
        crops = []
        crop_dets = []
        for d in detections:
            bbox = d.get("bbox")
            if not bbox:
                continue

            x1 = max(0, int(bbox["x1"]))
            y1 = max(0, int(bbox["y1"]))
            x2 = min(img_w, int(bbox["x2"]))
            y2 = min(img_h, int(bbox["y2"]))

            if (x2 - x1) < 15 or (y2 - y1) < 15:
                continue

            crop = image[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            crops.append(crop)
            crop_dets.append(d)

        if not crops:
            return

        try:
            crop_embs = backbone.extract_batch(crops)
        except Exception as e:
            print(f"[DailyItemIndexer] Error extracting crop embeddings: {e}")
            return

        # Stack each item's gallery once so scoring is a single matrix product
        # per item instead of a Python loop over individual embeddings.
        for d, crop_emb in zip(crop_dets, crop_embs):
            best_match_name = None
            best_sim = 0.0
            best_item_id = None
            best_thresh = self.EXEMPLAR_MATCH_THRESHOLD

            for item in user_items:
                thresh = item.get("threshold", self.EXEMPLAR_MATCH_THRESHOLD)
                # YOLO named this box, and the class it chose describes this
                # item: the one case with no observed false positives.
                if (item.get("threshold") is None
                        and self._names_agree(d.get("name", ""), item["name"])):
                    thresh = min(thresh, self.CLASS_AGREE_MATCH_THRESHOLD)
                sims = np.asarray(item["embeddings"]) @ crop_emb
                sim = float(sims.max()) if sims.size else 0.0
                if sim > best_sim and sim >= thresh:
                    best_sim = sim
                    best_match_name = item["name"]
                    best_item_id = item["id"]
                    best_thresh = thresh

            if best_match_name:
                generic_name = d["name"]
                d["matched_item"] = best_match_name
                d["enrolled_item_id"] = best_item_id
                d["exemplar_similarity"] = round(best_sim, 3)
                d["generic_name"] = generic_name
                d["name"] = best_match_name
                print(f"[DailyItemIndexer] Exemplar MATCH: '{generic_name}' -> '{best_match_name}' (sim={best_sim:.3f} >= {best_thresh})")

    def _check_and_enrich_activity(self, keyframe_id: str, detections: list[dict], metadata: dict,
                                   frame_shape: tuple | None = None):
        """
        Tier-2 Activity Gap-Filling:
        If Tier-1 produced no activity or was blind to the object class (e.g. Plate, Toothbrush, Soap),
        synthesize the activity from Objects365 detections and log an enriched activity event.
        """
        # Retired alongside the Tier-1 per-frame activity events. This gap-filler
        # asserted actions from object presence too -- a Plate resting on a table
        # at conf 0.77 logged "Eating in the dining area." while the wearer was
        # typing. Environment sessions (see _observe_scene) replace it.
        if not EMIT_TIER2_GAP_FILL_ACTIVITY:
            return

        tier1_activity = metadata.get("activity")
        tier1_sentence = metadata.get("sentence")
        tier1_env = metadata.get("environment")

        # If Tier-1 already found a confident activity (e.g. typing, drinking), do not override
        if tier1_activity and tier1_sentence and metadata.get("type") == "activity":
            return

        # Find best candidate from TIER2_GAP_FILL_ACTIVITY_MAP
        best_match = None
        best_conf = 0.0
        for d in detections:
            cid = d["class_id"]
            if cid not in TIER2_GAP_FILL_ACTIVITY_MAP or d["confidence"] <= best_conf:
                continue
            act_label, fallback_env = TIER2_GAP_FILL_ACTIVITY_MAP[cid]
            if act_label in TIER2_HANDHELD_ACTIVITIES and frame_shape:
                bb = d.get("bbox") or {}
                fh, fw = frame_shape[0], frame_shape[1]
                area_frac = (max(0, bb.get("x2", 0) - bb.get("x1", 0)) *
                             max(0, bb.get("y2", 0) - bb.get("y1", 0))) / float(fh * fw)
                if area_frac < TIER2_HANDHELD_MIN_AREA_FRAC:
                    print(f"[DailyItemIndexer] [Tier-2] Rejected '{act_label}' — "
                          f"{d['name']} at {area_frac:.2%} of frame is not handheld")
                    continue
            best_conf = d["confidence"]
            best_match = (act_label, fallback_env, d["name"], best_conf)

        if not best_match:
            return

        act_label, fallback_env, trigger_item, conf = best_match

        # Tier-2 synthesises activities from raw YOLO class confidence, which is
        # continuous and was firing as low as 0.30 — a Plate/Bowl on a desk
        # produced "Eating in the dining area." while the wearer was typing.
        # Tier-1's weakest real tier is 0.55; hold Tier-2 to the same bar rather
        # than letting it assert activities Tier-1 would never have claimed.
        if conf < TIER2_MIN_ACTIVITY_CONF:
            print(f"[DailyItemIndexer] [Tier-2] Rejected '{act_label}' — trigger "
                  f"{trigger_item}={conf:.3f} below {TIER2_MIN_ACTIVITY_CONF}")
            return
        env = tier1_env if tier1_env else fallback_env

        # Dedup enriched activities (120s window)
        user_key = str((metadata or {}).get("user_id", "unknown"))
        now_ts = time.monotonic()
        last_ts = self._last_enriched_activity.get((user_key, act_label))
        if last_ts is not None and (now_ts - last_ts) < 120.0:
            return
        self._last_enriched_activity[(user_key, act_label)] = now_ts

        # Synthesize sentence
        if act_label and env:
            sentence = f"{act_label.capitalize()} in the {env}."
        elif act_label:
            sentence = f"{act_label.capitalize()}."
        else:
            sentence = f"In the {env}."

        print(f"[DailyItemIndexer] [Tier-2 Enrichment] Synthesized activity '{sentence}' triggered by {trigger_item}={conf:.3f} on keyframe {keyframe_id}")

        # Write enriched activity to MongoDB
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            client = get_client()
            db = client[get_db_name()]
            ts_now = datetime.now(timezone.utc)
            user_id = metadata.get("user_id")
            if not user_id:
                return
            try:
                user_oid = ObjectId(str(user_id))
            except Exception:
                user_oid = str(user_id)

            # 1. Update keyframemetas
            db.keyframemetas.update_one(
                {"keyframe_id": keyframe_id},
                {"$set": {
                    "activity": act_label,
                    "environment": env,
                    "sentence": sentence,
                    "enriched_by": "yolo11n_object365",
                    "enriched_item": trigger_item,
                    "enriched_at": ts_now
                }},
                upsert=False
            )

            # 2. Insert enriched EventLog
            event_doc = {
                "user_id": user_oid,
                "event_type": "activity",
                "timestamp": ts_now,
                "confidence": round(conf, 2),
                "details": {
                    "action": act_label,
                    "activity": act_label,
                    "environment": env,
                    "sentence": sentence,
                    "description": sentence,
                    "trigger_item": trigger_item,
                    "gap_filled": True,
                    "source": "tier2_enrichment"
                },
                "keyframe_id": keyframe_id,
                "verification_status": "confirmed",
                "createdAt": ts_now,
                "updatedAt": ts_now
            }
            db.eventlogs.insert_one(event_doc)
            print(f"[DailyItemIndexer] [Tier-2 Enrichment] Successfully logged enriched activity event to EventLog for user {user_id}")
        except Exception as e:
            print(f"[DailyItemIndexer] [Tier-2 Enrichment] DB write note: {e}")

    def _persist_to_db(self, keyframe_id: str, detections: list[dict], item_names: list[str], metadata: dict):
        """Update keyframemetas and write object eventlog to MongoDB."""
        try:
            from pymongo import MongoClient
            from bson import ObjectId

            client = get_client()
            db = client[get_db_name()]

            user_id = metadata.get("user_id")
            if not user_id:
                return

            try:
                user_oid = ObjectId(str(user_id))
            except Exception:
                user_oid = str(user_id)

            ts_now = datetime.now(timezone.utc)
            # WHEN THE FRAME WAS TAKEN, not when this worker got round to it.
            # Indexing is queued behind YOLO, the embedding backbone and the
            # tile scan, and measured lag on real frames ran from 0.6s to 47.9s
            # as the queue drained at the end of a run. Stamping the memory with
            # the processing time files it minutes away from the moment it
            # records; the pipeline has always passed the capture time in
            # metadata and it was simply being ignored here.
            captured_at = _parse_ts(metadata.get("timestamp")) or ts_now

            identity_confs, class_confs = _confidences(detections)
            max_conf = max(identity_confs) if identity_confs else (
                max(class_confs) if class_confs else 0.0)

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
                        # 10 minutes, not 60: this location is what "last seen at"
                        # shows when an item goes missing outdoors. A fix from an
                        # hour ago can be a kilometre from where the item is.
                        if staleness_mins <= ITEM_LOCATION_MAX_STALENESS_MIN:
                            location = {
                                "lat": latest_loc["lat"],
                                "lng": latest_loc["lng"],
                                "accuracy": latest_loc.get("accuracy"),
                                "fix_age_s": round(staleness_mins * 60)
                            }
            except Exception as e:
                print(f"[DailyItemIndexer] Location lookup note: {e}")

            # 3. Create searchable EventLog entry for Memory Search (Module 7)
            # "Left here" rather than "Spotted": what the wearer will come
            # looking for is where they PUT something down, and these records
            # are now only written for items that were out of hand.
            all_placed = bool(detections) and all(
                d.get("placement") == "placed" for d in detections)
            verb = "Left" if all_placed else "Spotted"
            summary_str = f"{verb} {', '.join(item_names[:4])}"
            if len(item_names) > 4:
                summary_str += f" and {len(item_names) - 4} more"
            if all_placed:
                summary_str += " here"

            event_doc = {
                "user_id": user_oid,
                "event_type": "object",
                "timestamp": captured_at,
                "confidence": round(max_conf, 3),
                "details": {
                    "action": "item_seen",
                    "items": detections,
                    "item_names": item_names,
                    "summary": summary_str,
                    # At the event level too, so "where did I leave it" can be
                    # queried without unwinding the items array.
                    "placement": "placed" if all_placed else "mixed",
                    # Both numbers, named for the question each answers, so the
                    # UI never has to guess which one it is showing.
                    "identity_confidence": round(max(identity_confs), 3) if identity_confs else None,
                    "class_confidence": round(max(class_confs), 3) if class_confs else None,
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
            lag = (ts_now - captured_at).total_seconds()
            print(f"[DailyItemIndexer] Logged 'object' memory event for user {user_id} "
                  f"with {len(item_names)} items, filed at capture time "
                  f"({lag:.1f}s after the frame was taken)")

        except Exception as e:
            print(f"[DailyItemIndexer] DB error during persistence: {e}")
            traceback.print_exc()

    # ── Outdoor status from GPS (for FE-14 only) ─────────────────────────────
    def _is_outdoors_gps(self, user_id_str: str) -> bool:
        """True when the latest trustworthy GPS fix is > OUTDOOR_HOME_RADIUS_M
        from the user's home_location. Cached per user for
        OUTDOOR_STATUS_CACHE_S. Unknown (no home, no recent fix) is False."""
        if not user_id_str:
            return False
        cache = getattr(self, "_outdoor_cache", None)
        if cache is None:
            cache = self._outdoor_cache = {}
        now = time.monotonic()
        hit = cache.get(user_id_str)
        if hit and (now - hit[0]) < OUTDOOR_STATUS_CACHE_S:
            return hit[1]

        result = False
        try:
            from pymongo import MongoClient
            from bson import ObjectId
            from datetime import datetime, timedelta, timezone
            import math
            if self._db_client is None:
                self._db_client = get_client(serverSelectionTimeoutMS=2000)
            db = self._db_client[get_db_name()]
            try:
                uid_forms = [user_id_str, ObjectId(user_id_str)]
            except Exception:
                uid_forms = [user_id_str]
            user = db.users.find_one({"_id": {"$in": uid_forms}}, {"home_location": 1})
            home = (user or {}).get("home_location") or {}
            if isinstance(home.get("lat"), (int, float)) and isinstance(home.get("lng"), (int, float)):
                since = datetime.now(timezone.utc) - timedelta(minutes=OUTDOOR_MAX_FIX_AGE_MIN)
                fixes = db.locationlogs.find(
                    {"user_id": {"$in": uid_forms}, "timestamp": {"$gte": since}},
                    {"lat": 1, "lng": 1, "accuracy": 1},
                ).sort("timestamp", -1).limit(10)
                for f in fixes:
                    if (f.get("accuracy") or 0) > OUTDOOR_MAX_FIX_ACCURACY_M:
                        continue
                    if not isinstance(f.get("lat"), (int, float)):
                        continue
                    # haversine
                    r = 6371000.0
                    p1, p2 = math.radians(home["lat"]), math.radians(f["lat"])
                    dphi = p2 - p1
                    dlam = math.radians(f["lng"] - home["lng"])
                    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
                    dist = 2 * r * math.asin(math.sqrt(h))
                    result = dist > OUTDOOR_HOME_RADIUS_M
                    break
        except Exception as e:
            print(f"[DailyItemIndexer] outdoor status lookup failed: {e}")

        cache[user_id_str] = (now, result)
        return result

    # ── Held, or put down? ───────────────────────────────────────────────────
    def _hand_boxes(self, image) -> list[dict] | None:
        """The wearer's hand boxes in this frame, or None if unavailable.

        None and [] mean different things: [] is "looked, saw no hands", None is
        "could not look". Only [] is evidence that an item is not being held.
        """
        try:
            if getattr(self, "_gesture", None) is None:
                from ai.gesture import GestureDetector
                self._gesture = GestureDetector()
            result = self._gesture.analyze_frame(image)
            return list(result.get("all_hand_bboxes") or [])
        except Exception as e:
            if not getattr(self, "_warned_no_hands", False):
                print(f"[DailyItemIndexer] hand detector unavailable, every item "
                      f"will be recorded as put down: {e}")
                self._warned_no_hands = True
            return None

    def _is_held(self, bbox: dict, hand_boxes: list[dict] | None,
                 frame_w: int, frame_h: int) -> bool:
        """Is this item in the wearer's hand right now?"""
        x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
        area = max(1, (x2 - x1) * (y2 - y1))

        # Filling the view means it is at the camera, whatever the hands say.
        if area / float(max(1, frame_w * frame_h)) >= ITEM_HELD_MAX_AREA_FRAC:
            return True
        if not hand_boxes:
            return False      # [] is real evidence; None was handled by caller

        pad = int(ITEM_HELD_NEAR_FRAC * frame_w)
        for hb in hand_boxes:
            hx1, hy1 = hb["x1"] - pad, hb["y1"] - pad
            hx2, hy2 = hb["x2"] + pad, hb["y2"] + pad
            ox = max(0, min(x2, hx2) - max(x1, hx1))
            oy = max(0, min(y2, hy2) - max(y1, hy1))
            if (ox * oy) / float(area) >= ITEM_HELD_OVERLAP_FRAC:
                return True
        return False

    # ── Environment sessions ─────────────────────────────────────────────────
    def _observe_scene(self, all_detections: dict[str, float], user_id_str: str,
                       keyframe_id: str, metadata: dict):
        """Feed one keyframe's raw Objects365 detections to the scene tracker.

        Emits an event only when a session CLOSES, so the feed carries
        "Kitchen activity for 25 minutes" rather than a label per frame.
        """
        if not user_id_str:
            return
        try:
            from ai.scene import classify_scene, SceneSessionTracker
        except Exception as e:
            print(f"[DailyItemIndexer] scene module unavailable: {e}")
            return

        tracker = self._scene_trackers.get(user_id_str)
        if tracker is None:
            tracker = SceneSessionTracker()
            self._scene_trackers[user_id_str] = tracker

        room, score, _ = classify_scene(all_detections)
        ts = time.time()
        session = tracker.observe(room, all_detections, ts,
                                  keyframe_id=keyframe_id, score=score)
        if session:
            # The session's OWN best frame. Passing the frame in hand here
            # attached the next room's photo to every session that closed.
            self._persist_scene_session(
                session, user_id_str, session.get("keyframe_id"))

        # Write the session that is still OPEN, and keep it up to date. Without
        # this the feed shows nothing for as long as the wearer stays in one
        # room: a real recording sat in the bedroom for three minutes, saved
        # nine frames of it, and produced no memory at all, because the session
        # had not ended yet. It also means a run that is killed rather than
        # stopped cleanly no longer loses the room it was in.
        open_session = tracker.snapshot(ts)
        if open_session:
            self._persist_scene_session(
                open_session, user_id_str, open_session.get("keyframe_id"))

    def flush_scene_sessions(self, user_id_str: str | None = None):
        """Close open sessions, e.g. when a stream stops."""
        targets = [user_id_str] if user_id_str else list(self._scene_trackers)
        for uid in targets:
            tracker = self._scene_trackers.get(uid)
            if not tracker:
                continue
            session = tracker.flush()
            if session:
                self._persist_scene_session(session, uid, session.get("keyframe_id"))

    def _persist_scene_session(self, session: dict, user_id_str: str, keyframe_id: str | None):
        """Write an environment session to EventLog, open or closed.

        Upserted on the session's own id rather than inserted, because the same
        session is written repeatedly: once as soon as it is confirmed, again
        each time it grows, and finally when it closes. Inserting would leave a
        row per update, all of them claiming the same stretch of time.

        Uses event_type "activity" with details.action "scene_session" so the
        existing memory-search query and the feed's activity renderer pick it up
        unchanged -- the renderer shows details.sentence as the title.
        """
        try:
            from bson import ObjectId
            from datetime import datetime, timezone
            if self._db_client is None:
                self._db_client = get_client(serverSelectionTimeoutMS=2000)
            db = self._db_client[get_db_name()]
            try:
                user_oid = ObjectId(user_id_str)
            except Exception:
                user_oid = user_id_str

            minutes = max(1, round(session["duration_seconds"] / 60))
            # No dash: these strings are read by the person and their caregiver,
            # and a dash-joined fragment reads as machine output.
            sentence = f"{session['label']} for {minutes} min"
            in_progress = bool(session.get("in_progress"))
            ts_now = datetime.now(timezone.utc)
            session_id = session.get("session_id")

            details = {
                "action": "scene_session",
                "scene": session["scene"],
                "sentence": sentence,
                "description": sentence,
                "label": session["label"],
                "duration_seconds": session["duration_seconds"],
                "keyframes": session["keyframes"],
                "evidence": session["evidence"],
                "session_id": session_id,
                "in_progress": in_progress,
                "source": "scene_sessions",
            }
            doc = {
                "user_id": user_oid,
                "event_type": "activity",
                "timestamp": datetime.fromtimestamp(session["start_ts"], tz=timezone.utc),
                "confidence": 0.8,
                "details": details,
                "keyframe_id": keyframe_id,
                "verification_status": "confirmed",
                "updatedAt": ts_now,
            }

            if session_id:
                db.eventlogs.update_one(
                    {"user_id": user_oid, "details.session_id": session_id},
                    {"$set": doc, "$setOnInsert": {"createdAt": ts_now}},
                    upsert=True,
                )
            else:
                # A session from before ids existed, or one built by hand.
                doc["createdAt"] = ts_now
                db.eventlogs.insert_one(doc)

            state = "open" if in_progress else "closed"
            print(f"[DailyItemIndexer] [Scene] {sentence} ({state}, "
                  f"{session['keyframes']} keyframes, evidence "
                  f"{list(session['evidence'])[:3]})")
        except Exception as e:
            print(f"[DailyItemIndexer] Error persisting scene session: {e}")

    # ── Tiled exemplar scan ──────────────────────────────────────────────────
    def _tile_regions(self, img_w: int, img_h: int) -> list[tuple[int, int, int, int]]:
        """Multi-scale sliding windows over the searchable region of the frame."""
        x0 = int(TILE_REGION_X[0] * img_w)
        x1 = int(TILE_REGION_X[1] * img_w)
        y0 = int(TILE_REGION_Y0 * img_h)
        regions = []
        for frac in TILE_SCALE_FRACS:
            size = max(TILE_MIN_PX, int(frac * img_w))
            stride = max(8, int(size * TILE_STRIDE_FRAC))
            for yy in range(y0, max(y0 + 1, img_h - size + 1), stride):
                for xx in range(x0, max(x0 + 1, x1 - size + 1), stride):
                    regions.append((xx, yy, min(img_w, xx + size), min(img_h, yy + size)))
        return regions

    def _scan_tiles_for_enrolled_items(self, image: np.ndarray, user_id_str: str,
                                       exclude_item_ids: set | None = None) -> list[dict]:
        """Find enrolled items that YOLO failed to box, by scanning the frame directly.

        Decision rule is deliberately winner-take-all per item rather than
        "every region over threshold": an enrolled belonging appears at most once
        in a frame, and accepting every region above 0.65 produced false positives
        in 4/6 frames against 4/6 detections. Taking only each item's best-scoring
        region gave 5/6 detections with 0 false positives on the same frames.

        Returns synthesized detection dicts, already carrying matched_item, so the
        existing dedup and identity-gated persistence path handles them unchanged.
        """
        user_items = self._get_user_items_cached(user_id_str)
        if exclude_item_ids:
            # Items already matched from a YOLO box in this frame need no scan.
            user_items = [it for it in user_items if it["id"] not in exclude_item_ids]
        if not user_items:
            return []
        backbone = self._get_embedding_backbone()
        if backbone is None:
            return []

        img_h, img_w = image.shape[:2]
        regions, crops = [], []
        for r in self._tile_regions(img_w, img_h):
            if (r[2] - r[0]) < TILE_MIN_PX or (r[3] - r[1]) < TILE_MIN_PX:
                continue
            crop = image[r[1]:r[3], r[0]:r[2]]
            if crop.size == 0:
                continue
            regions.append(r)
            crops.append(crop)
        if not crops:
            return []

        t0 = time.perf_counter()
        try:
            embs = backbone.extract_batch(crops)
        except Exception as e:
            print(f"[DailyItemIndexer] Tile scan embedding failed: {e}")
            return []

        best: dict[str, tuple[float, tuple, dict]] = {}
        for region, emb in zip(regions, embs):
            for item in user_items:
                thresh = item.get("threshold", self.EXEMPLAR_MATCH_THRESHOLD)
                sims = np.asarray(item["embeddings"]) @ emb
                sim = float(sims.max()) if sims.size else 0.0
                if sim < thresh:
                    continue
                cur = best.get(item["id"])
                if cur is None or sim > cur[0]:
                    best[item["id"]] = (sim, region, item)

        elapsed = (time.perf_counter() - t0) * 1000
        if not best:
            print(f"[DailyItemIndexer] Tile scan: {len(crops)} regions, no match ({elapsed:.0f}ms)")
            return []

        out = []
        for item_id, (sim, region, item) in best.items():
            print(f"[DailyItemIndexer] Tile scan MATCH: '{item['name']}' "
                  f"(sim={sim:.3f}) at {region} over {len(crops)} regions ({elapsed:.0f}ms)")
            out.append({
                "name": item["name"],
                "class_id": -1,                 # no YOLO class: found by tile scan
                "confidence": round(sim, 3),
                "bbox": {"x1": region[0], "y1": region[1], "x2": region[2], "y2": region[3]},
                "matched_item": item["name"],
                "enrolled_item_id": item_id,
                "exemplar_similarity": round(sim, 3),
                "generic_name": "tile_scan",
            })
        return out


# ── module level ──

# ── Enrollment-side tight cropping ───────────────────────────────────────────
ENROLL_CROP_MARGIN = 0.15      # padding added around the detected box
ENROLL_CROP_MIN_CONF = 0.25    # below this, keep the full photo
ENROLL_CROP_MIN_AREA = 0.02    # ignore specks
ENROLL_CROP_MAX_AREA = 0.90    # ignore whole-scene boxes


def tight_crop_enrollment_image(image_bgr: np.ndarray,
                                margin: float = ENROLL_CROP_MARGIN) -> np.ndarray:
    """Crop a phone enrollment photo down to the object it is a photo OF.

    Enrollment photos frame the item against whatever it was lying on, and
    MobileNetV3 embeds that background along with the item. Measured on the real
    Car Keys enrollment photo (keys on a yellow sofa) against the four live
    chest-cam frames, distractor-controlled:

        full photo   keys ranked #1 in 3/4, 0/4 above threshold, mean margin +0.157
                     -- and in the frame that fired in production the wearer's
                     black phone scored 0.558 vs the keys' 0.551, i.e. the phone
                     won and was logged as "Car Keys"
        tight +15%   keys ranked #1 in 4/4, 3/4 above threshold, mean margin +0.320
                     -- phone falls to 0.633, below the 0.65 threshold, 0 false
                     positives across all four frames

    The class label is deliberately ignored. Objects365 calls these keys
    "Motorcycle" at 0.83 confidence, but the BOX is tight and correct, and only
    the box is used. Cropping to a wrong-labelled box is fine; the exemplar
    gallery never sees the label.

    Falls back to the untouched image whenever localisation is not confident,
    so a photo the detector cannot parse still enrolls as it did before.
    """
    if image_bgr is None or image_bgr.size == 0:
        return image_bgr

    try:
        indexer = DailyItemIndexer.get_instance()
        indexer._ensure_model_loaded()
        model = indexer._model
        if model is None:
            return image_bgr

        h, w = image_bgr.shape[:2]
        frame_area = float(h * w)
        results = model(image_bgr, conf=ENROLL_CROP_MIN_CONF, verbose=False)
        if not results or results[0].boxes is None or len(results[0].boxes) == 0:
            return image_bgr

        best_box, best_conf = None, 0.0
        for box in results[0].boxes:
            conf = float(box.conf[0].item())
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            area = max(0.0, (x2 - x1)) * max(0.0, (y2 - y1)) / frame_area
            if not (ENROLL_CROP_MIN_AREA <= area <= ENROLL_CROP_MAX_AREA):
                continue
            if conf > best_conf:
                best_conf, best_box = conf, (x1, y1, x2, y2)

        if best_box is None:
            return image_bgr

        x1, y1, x2, y2 = best_box
        px, py = (x2 - x1) * margin, (y2 - y1) * margin
        cx1 = max(0, int(x1 - px))
        cy1 = max(0, int(y1 - py))
        cx2 = min(w, int(x2 + px))
        cy2 = min(h, int(y2 + py))
        if cx2 - cx1 < 20 or cy2 - cy1 < 20:
            return image_bgr

        print(f"[enrollment] tight crop {w}x{h} -> {cx2-cx1}x{cy2-cy1} "
              f"(box conf={best_conf:.2f}, margin={margin:.0%})")
        return image_bgr[cy1:cy2, cx1:cx2]

    except Exception as e:
        print(f"[enrollment] tight crop failed, using full image: {e}")
        return image_bgr
