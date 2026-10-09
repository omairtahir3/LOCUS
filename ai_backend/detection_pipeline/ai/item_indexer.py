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

import glob
import os
import re
import statistics
import time
import queue
import threading
import traceback
from datetime import datetime, timedelta, timezone
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

# The bar a box must clear to be CONSIDERED as one of the wearer's belongings.
# Far below the bar for reporting an unidentified object, because identity is
# decided by the exemplar gallery afterwards and the gallery is much better at
# it: on real frames a phone on a desk scored 0.885 and 0.891 against the
# gallery while YOLO rated the same boxes 0.117 and 0.276, and a genuine
# non-match scored 0.416. Confidence tracks how BIG and near a thing is; the
# gallery tracks whether it is the right thing.
ENROLLED_CANDIDATE_CONF = float(os.environ.get("ENROLLED_CANDIDATE_CONF", 0.08))

# What a faint box must score against the gallery to be believed. Set from the
# gap in the measured data: the two genuine put-downs the old bar discarded
# scored 0.885 and 0.891, and the marginal junk alongside them scored 0.663 and
# 0.666. 0.75 sits in that gap with room either side.
LOW_CONF_MATCH_THRESHOLD = float(os.environ.get("LOW_CONF_MATCH_THRESHOLD", 0.75))

# How far ahead the best-matching belonging must be before it is believed.
#
# A box matched the wearer's Phone at 0.770 and their Rover Earbuds at 0.763 in
# the same frame. Nothing in that pair of numbers identifies an object; it is
# noise deciding which name gets attached. Galleries built from fifteen varied
# photographs overlap far more than four-photograph ones did, so this will
# happen whenever two belongings share a colour or a silhouette.
#
# 0.05 is wider than the 0.007 that was observed and narrower than the gap on a
# clean match, where the right item typically leads by 0.1 or more.
AMBIGUOUS_MARGIN = float(os.environ.get("AMBIGUOUS_MARGIN", 0.05))

# How many candidates may be embedded per frame. Batched at a measured 61 ms
# each, so this is the frame's embedding budget: 8 is about half a second in the
# worst case, on a background worker with its own queue. Boxes above the normal
# confidence bar are taken first, so the behaviour that already worked cannot be
# crowded out by the faint boxes this cap exists to bound.
MAX_CANDIDATES_PER_FRAME = int(os.environ.get("MAX_CANDIDATES_PER_FRAME", 8))
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

# When a put-down counts as a NEW place rather than a repeat, on position alone.
#
# Zero overlap, because the camera is worn: turning the wearer's head moves
# every box in frame, so anything short of "no shared pixels at all" would call
# a glance a move. And only against a recent sighting, since two boxes minutes
# apart may be different views rather than different places.
MOVED_SPOT_IOU = float(os.environ.get("MOVED_SPOT_IOU", 0.0))
MOVED_SPOT_MAX_AGE = float(os.environ.get("MOVED_SPOT_MAX_AGE", 300))

# The same gate for a HELD sighting, which is a different kind of record. A held
# sighting writes no keyframe and never reaches the feed; it exists so the
# monitor can tell "carried away" from "left behind", and so a put-down that
# follows a pick-up is recognised as a new place rather than a repeat. Rate
# limiting that on the fifteen-minute window meant a phone carried to another
# room six minutes later had its pick-up suppressed, and the put-down in the new
# room was then indistinguishable from the old one. 60 s is enough to stop a row
# per frame, which is all this needs to prevent.
ITEM_HELD_DEDUP_SECONDS = float(os.environ.get("ITEM_HELD_DEDUP_SECONDS", 60))

# Is a put-down in the same place as the last one that kept a frame?
#
# Overlap alone cannot answer it. Measured across one real session, the repeats
# of a stationary phone overlapped 1.000 (four frames, the box (377,518)-(519,600)
# reproduced exactly) and 0.322 (two frames a second apart, the camera drifting),
# while the genuine moves overlapped 0.000, 0.026 and 0.338. A repeat at 0.322
# and a move at 0.338 leave no threshold between them.
#
# Time separates what overlap cannot: the 0.322 repeat was ONE SECOND after its
# predecessor, the 0.338 move was twenty-six minutes. So two rules, and either
# is enough:
#   a box that plainly is the previous one, whenever it was seen;
#   a roughly similar box seen again within moments, which is camera drift
#   around a thing that has not gone anywhere.
SAME_SPOT_IOU = float(os.environ.get("SAME_SPOT_IOU", 0.50))
SAME_SPOT_DRIFT_IOU = float(os.environ.get("SAME_SPOT_DRIFT_IOU", 0.25))
SAME_SPOT_DRIFT_SECONDS = float(os.environ.get("SAME_SPOT_DRIFT_SECONDS", 30))
# How many recent put-downs of one item to compare a new one against. Frames
# are indexed out of the order they were captured, so the row that duplicates
# this one is not reliably the newest; a dozen covers the whole dedup window at
# any rate the queue achieves, and they all arrive from the one query.
SAME_SPOT_LOOKBACK = int(os.environ.get("SAME_SPOT_LOOKBACK", 12))

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

# Whether to consult the hands at all. The name is historical: it once meant
# "drop held sightings", and held sightings are now RECORDED as in_hand rather
# than dropped, because a belonging seen leaving the surface in a hand is the
# only evidence that the wearer took it with them. What the flag still decides
# is whether placement is judged (placed vs in_hand) or left as "unknown".
#
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

# How many frames may wait to be indexed before the OLDEST are dropped.
#
# The queue was bounded by COUNT (100) and not by time, so it absorbed a
# backlog instead of shedding one. On a saturated machine a single frame took
# 90 seconds to index, 63 were waiting, and a sighting reached the database 275
# seconds after the shutter:
#
#   Detected 1 items (Phone) ... in 90375.7ms
#   Logged 'object' memory event ... (274.8s after the frame was taken)
#
# Dropping the oldest keeps the lag bounded and keeps what is indexed recent,
# which is what a memory aid needs: a five-minute-old queue is worth less than
# the frame being taken right now, and every frame in it delays that one.
INDEX_QUEUE_HIGH_WATER = int(os.environ.get("INDEX_QUEUE_HIGH_WATER", 8))

# The oldest a frame may be, at the moment the worker picks it up, and still be
# worth running detection on. Depth alone does not bound lag: eight frames at the
# 1.3 s they cost on an idle machine is ten seconds, but at the 31 s per frame
# reached under load it is four minutes, and measured write lag hit 172 s.
#
# A put-down noticed three minutes late cannot produce a useful "you left this
# behind": the wearer has been in another room for two of those minutes, and the
# alert either never fires or arrives about somewhere they have long since left.
# Detection has to land inside the window an alert can still act on, so a frame
# past this age is dropped unprocessed rather than delaying every newer one.
MAX_INDEX_AGE_SECONDS = float(os.environ.get("MAX_INDEX_AGE_SECONDS", 45))

# ── Learning the item from the camera that has to recognise it ──────────────
#
# An enrolment photo is taken with a phone camera, close up, in one room. The
# wearable sees the same object small, at an angle, across a desk, in whatever
# light the room has. Those are different enough that the gallery matched only
# 10 of 19 real sightings of the wearer's own phone.
#
# Measured on those 35 crops, seeding the gallery with four of the wearer's own
# high-confidence sightings and augmenting each across lighting and angle, with
# leave-one-out so nothing is graded on its own copy:
#
#   enrolled gallery as it stands           10/19 sightings matched
#   + augmented from the stored photo       10/19   (no gain)
#   + 4 wearable crops                      14/19
#   + those 4 crops augmented               16/19
#
# The enrolment photo is not the problem to solve; the gap between the two
# cameras is. So a confident match adds itself back to the gallery.
# 0.70, set from the data rather than picked. 0.80 was tried first and made the
# whole feature dead on arrival: the wearer's best real phone sighting scores
# 0.785, so nothing would ever have qualified and the gallery would never have
# learned anything. 0.70 sits above every one of the 16 mouse sightings, whose
# best is 0.654, and admits 7 of the 19 real phone sightings as seeds.
#
# It is the second guard, not the first. Learning only happens on a crop that
# already MATCHED, and a crop the detector labelled Mouse has to clear 0.85 to
# match at all, which no mouse in the data comes close to.
# The item gallery does NOT learn from its own sightings, and must not.
#
# It used to. The idea was reasonable: enrolment photographs come from a phone
# camera and matching happens on a wearable one, so a sighting the gallery
# already recognises is a picture of the right object through the right lens.
# In practice it taught itself in a circle, because the only evidence it ever
# had was resemblance to ITSELF, and resembling the gallery is not evidence of
# being the object once the gallery is mostly its own output.
#
# It ran to the end on this account: 160 phone exemplars, 156 of them the
# system's own output and 4 real photographs. The 156 scored 0.567 against those
# photographs while the wearer's car keys scored 0.443. The gallery had stopped
# describing the phone.
#
# Anchoring new exemplars to the enrolment photographs fixed that case, and then
# stopped working, for a reason worth recording. Once enrolment asked for fifteen
# varied photographs instead of four, the galleries became larger and looser, and
# a larger looser gallery clears any threshold more easily:
#
#     car keys photos vs the PHONE gallery:  max 0.860
#     phone photos vs the CAR KEYS gallery:  max 0.860
#     the anchor meant to separate them:     0.78
#
# One belonging reached further into another's gallery than the bar meant to
# exclude it. No threshold separates "same object, new view" from "different
# object" on this embedding, because the distributions overlap.
#
# Learning in this system belongs in routine learning, which watches WHEN and
# WHERE a person does things and has the wearer's own history to be right or
# wrong against. An item's appearance has no such ground truth: only the person
# adding a photograph knows what the object is.
#
# LEARNED_SOURCE_BASE is gone with it. It marked which exemplars the system had
# taught itself, and nothing writes one any more. The Node side still reads
# embedding_sources when it reports gallery health, which is harmless and stays:
# it keeps grading older galleries honestly, since vectors learned before this
# are still in some of them.


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

    # And a HIGHER bar when YOLO boxed the object and named it something that
    # is plainly not this item. The agreement rule was only ever applied in one
    # direction, which left disagreement sitting at the default, and a real run
    # produced exactly the failure the original calibration had warned about:
    #
    #   [DailyItemIndexer] Exemplar MATCH: 'Mouse' -> 'Phone' (sim=0.798 >= 0.74)
    #
    # The same gallery matched a genuine 'Cell Phone' at 0.785 in the same run,
    # so raw similarity cannot separate them: the mouse scored HIGHER than the
    # phone. The class name is the only thing that distinguishes the two, and it
    # was being ignored. This sits above the mouse and leaves the class-agreeing
    # path untouched, where the real matches are.
    #
    # It matters beyond a wrong caption. A false sighting refreshes the item's
    # last-seen time, so "you left your phone behind" can never fire while a
    # mouse on the desk keeps reporting the phone as present.
    CLASS_DISAGREE_MATCH_THRESHOLD = 0.85
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
        # (user, item identity, room) -> monotonic ts. The room is part of the
        # key so the same belonging is recorded again when it moves.
        self._last_item_seen: dict[tuple[str, Any, Any], float] = {}
        # Where each kind of sighting was last RECORDED, so a later one can be
        # told apart from a repeat without having caught the item in a hand.
        self._last_item_box: dict[tuple[str, Any, Any], dict] = {}
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

        # Shed the OLDEST waiting frames rather than let the backlog become
        # minutes of lag (see INDEX_QUEUE_HIGH_WATER).
        dropped = 0
        while self._queue.qsize() >= INDEX_QUEUE_HIGH_WATER:
            try:
                self._queue.get_nowait()
                self._queue.task_done()
                dropped += 1
            except queue.Empty:
                break
        if dropped:
            # Once the backlog is at the mark it stays there, so every enqueue
            # drops one and would print. Report at most once every ten seconds,
            # with the running total, rather than a line per frame in a log
            # that is already hard to read.
            self._dropped_total = getattr(self, "_dropped_total", 0) + dropped
            last = getattr(self, "_dropped_logged_at", 0.0)
            if (time.monotonic() - last) >= 10.0:
                self._dropped_logged_at = time.monotonic()
                print(f"[DailyItemIndexer] backlog at {INDEX_QUEUE_HIGH_WATER}; "
                      f"dropped {self._dropped_total} stale frame(s) so far so the "
                      f"newest is indexed promptly")

        try:
            self._queue.put_nowait(task)
            return True
        except queue.Full:
            print(f"[DailyItemIndexer] WARNING: Queue full, dropping keyframe {keyframe_id}")
            return False

    def _worker_loop(self):
        """Background worker thread loop."""
        while self._is_running:
            try:
                task = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            try:
                # Age, not queue depth, is what makes a sighting useless.
                #
                # The backlog was already capped at INDEX_QUEUE_HIGH_WATER
                # frames, which bounds the lag only if each frame costs what it
                # should: eight frames at 1.3 s is ten seconds, but at the 31 s
                # per frame this machine was actually reaching it is four
                # minutes. Measured write lag reached 172 s, and a put-down
                # noticed three minutes after it happened cannot produce a
                # useful "you left this behind" -- by then the wearer has been
                # in another room for two of those minutes.
                #
                # So a frame older than this is dropped unprocessed. Skipping it
                # costs one sighting; processing it delays every newer frame
                # behind it and answers a question nobody can still act on.
                age = time.time() - task.get("enqueued_at", time.time())
                if age > MAX_INDEX_AGE_SECONDS:
                    self._stale_total = getattr(self, "_stale_total", 0) + 1
                    last = getattr(self, "_stale_logged_at", 0.0)
                    if (time.monotonic() - last) >= 10.0:
                        self._stale_logged_at = time.monotonic()
                        print(f"[DailyItemIndexer] skipped {self._stale_total} frame(s) older than "
                              f"{MAX_INDEX_AGE_SECONDS:.0f}s on dequeue; newest first keeps detection "
                              f"within the window an alert can still act on")
                    continue
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
        # For ENROLLED belongings the detector's confidence is the wrong gate,
        # and it was throwing away the sightings that matter most.
        #
        # YOLO is least confident about small distant objects, which is exactly
        # what a phone on a desk across the room is, and exactly the sighting
        # this feature exists to record. Measured over the 04:40-04:50 window,
        # where two put-downs produced no event at all:
        #
        #   04:41:23  Cell Phone  conf=0.117  area=0.0059  similarity 0.885
        #   04:48:16  Cell Phone  conf=0.276  area=0.0067  similarity 0.891
        #
        # Both are the phone on a surface, both would have been recognised by
        # the gallery outright, and both were discarded before the gallery was
        # ever asked. Seven of sixteen candidates in that window went the same
        # way. Meanwhile a genuine non-match scored 0.416, far below the 0.65
        # bar, so identity is doing the discriminating and confidence is only
        # discarding distance.
        #
        # Candidates therefore come in at a much lower bar and the exemplar
        # match decides. _conf still governs what may be logged WITHOUT an
        # identity match, so unenrolled clutter is unaffected.
        _cand_conf = min(_conf, ENROLLED_CANDIDATE_CONF)
        results = self._model(image, conf=_cand_conf, iou=0.45, verbose=False)
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
            if conf < _cand_conf:   # candidate bar; identity is the real gate
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

        # Bounded, highest confidence first. Each candidate costs one MobileNet
        # pass in the matcher below, and dropping the bar to consider distant
        # belongings also lets in more clutter, so a cluttered frame must not be
        # able to queue dozens of embeddings.
        if len(detections) > MAX_CANDIDATES_PER_FRAME:
            # Confident boxes first, so nothing that already worked is displaced
            # by a faint one; the cap then bounds how many faint ones follow.
            detections.sort(key=lambda d: d["confidence"], reverse=True)
            dropped = [d for d in detections[MAX_CANDIDATES_PER_FRAME:]]
            detections = detections[:MAX_CANDIDATES_PER_FRAME]
            print(f"[Items] {len(dropped)} candidate(s) past the per-frame cap of "
                  f"{MAX_CANDIDATES_PER_FRAME} were not embedded "
                  f"(weakest kept {detections[-1]['confidence']:.3f}, "
                  f"strongest dropped {dropped[0]['confidence']:.3f})")

        # ── Environment session tracking ─────────────────────────────────────
        # Runs on every keyframe, before any item-related early return: the room
        # the wearer is in does not depend on whether they own anything in view.
        user_id_str = str((metadata or {}).get("user_id", ""))
        # Returns True when the room itself is private. Everything below this
        # line stores something derived from this frame -- an item crop, a
        # sighting row, a session cover photograph -- so a washroom frame has to
        # stop here rather than merely be left out of the room history.
        if self._observe_scene(scene_detections, user_id_str, keyframe_id, metadata):
            return

        # A PROBE exists only to answer "is the wearer still in the private
        # room?". _observe_scene has now answered it, either closing the gate
        # again or lifting it, and everything below this line stores or records
        # something. The frame itself was never written to disk, so there is
        # nothing to clean up either.
        if (metadata or {}).get("privacy_probe"):
            return

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
                    tiles = self._scan_tiles_for_enrolled_items(
                        image, user_id_str, exclude_item_ids=already_matched)
                    if tiles:
                        tiles = self._corroborated_tiles(tiles, detections, image)
                    detections.extend(tiles)

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
        if detections:
            print(f"[Items] {str(keyframe_id)[:8]} -> "
                  f"{[d.get('matched_item') or d['name'] for d in detections]} | hands "
                  + ("unavailable" if hand_boxes is None else f"seen {len(hand_boxes)}"))
        # ── Held, put down, or not known ─────────────────────────────────────
        #
        # "The detector looked and saw no hands" used to mean PUT DOWN, and that
        # is what stored frames of the wearer holding their own phone. It is not
        # evidence: measured over all 20 stored frames, MediaPipe found a hand in
        # only 11, and it missed two hands wrapped round a phone on a frame with
        # luminance 104.5, which is not a dark frame. Brightening recovers some
        # of those (see _hand_boxes) but not that one.
        #
        # So the hands are believed only when they are actually seen. When they
        # are not, the fallback is how big the item is, because on a camera worn
        # on the chest a held thing is about 30 cm away and a thing on a desk is
        # a metre or more: measured, the phone occupied 8.2, 12.3 and 14.9% of
        # the frame while held, and about 1.5% sitting on the desk.
        #
        # That ratio is per ITEM, never global. A single global fraction is what
        # made an earlier version call a laptop on a desk "held", because a
        # laptop is simply bigger than a phone. Each belonging is calibrated from
        # its own history, and until it has one it reports `unknown` and no frame
        # is stored -- an unrecorded put-down is recoverable, a memory of the
        # wearer holding their own phone is the thing being complained about.
        user_key = str((metadata or {}).get("user_id", "unknown"))
        frame_area = float(max(1, img_w * img_h))
        for d in detections:
            b = d["bbox"]
            d["area_frac"] = round(
                max(0, (b["x2"] - b["x1"])) * max(0, (b["y2"] - b["y1"])) / frame_area, 4)

        if not (detections and LOG_ONLY_PLACED_ITEMS) or hand_boxes is None:
            for d in detections:
                d["placement"] = "unknown"      # could not look, so claim nothing
                d["hands_seen"] = False
        else:
            for d in detections:
                thr = self._held_size_threshold(user_key, d.get("enrolled_item_id") or d["class_id"])
                overlap_held = bool(hand_boxes) and self._is_held(d["bbox"], hand_boxes, img_w, img_h)
                # Size is an OVERRIDE, not only a fallback. At 04:34 a frame of
                # the phone plainly in the wearer's hand was stored as put down:
                # hands WERE seen (an arm resting on the laptop), none of them
                # overlapped the phone's box, and that was taken as proof. It is
                # not proof. The hand holding a phone is routinely behind it, cut
                # off at the frame edge, or simply missed, and the phone was
                # 10.1% of the frame at the time -- squarely in its own held
                # range of 8.2 to 14.9%, against 0.6% on a desk.
                size_held = thr is not None and d["area_frac"] >= thr
                # ...and size can VETO a hand overlap as well as assert one.
                #
                # _is_held measures the overlap as a fraction of the ITEM's own
                # area, so a small distant object is trivially "held": a hand
                # anywhere near it in the flat projection covers 15% of
                # something 70 px wide without being anywhere near it in the
                # room. Measured, the phone at 0.0156 of the frame -- its own
                # put-down cluster sits at 0.013, its held cluster at 0.119 --
                # was recorded in_hand because a hand was elsewhere in view.
                # That stored no frame and told the left-behind check the phone
                # had been carried away, so no alert was raised either.
                #
                # A thing in your hand is about 30 cm from a camera on your
                # chest. If it is far smaller than this item has ever been while
                # held, it is not in a hand, whatever the boxes overlap.
                size_says_placed = thr is not None and d["area_frac"] < thr
                if size_says_placed:
                    d["placement"] = "placed"
                elif overlap_held or size_held:
                    d["placement"] = "in_hand"
                elif hand_boxes:
                    d["placement"] = "placed"
                else:
                    # No hands seen and no size opinion yet: nothing is known.
                    d["placement"] = "unknown"
                # Only labels the HANDS decided may train the size threshold.
                # Anything size decided, in either direction, would otherwise
                # feed its own output back and harden one mistake into the number
                # that produced it.
                size_decided = size_says_placed or (size_held and not overlap_held)
                d["hands_seen"] = bool(hand_boxes) and not size_decided
                if size_says_placed and overlap_held:
                    print(f"[Items] a hand box overlapped {d.get('matched_item', d['name'])}, but at "
                          f"{d['area_frac']:.4f} of the frame against its own {thr:.3f} held size it is "
                          f"too far away to be in one; recorded as put down")
                elif size_held and not overlap_held:
                    print(f"[Items] {d.get('matched_item', d['name'])} is {d['area_frac']:.3f} of the "
                          f"frame against its own {thr:.3f} held threshold, so it is in a hand "
                          f"even though no hand box covered it")

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
        # 3. MOVED: an item put down again after being carried is news, whatever
        #    the clock says, because where a belonging is NOW is the only thing
        #    this feature exists to answer.
        #
        # The third rule replaces keying on the room. The room was in the key so
        # that carrying something next door recorded it again, but measured on
        # this database 0 of the 60 most recent item events fell inside a named
        # room session: current_room is None almost always, so every sighting
        # shared one bucket and moving an item anywhere was swallowed as a
        # repeat for fifteen minutes. The pick-up is the signal instead. It needs
        # no room, which is also what makes this work upstairs and downstairs, in
        # rooms the classifier will never name.
        #
        # in_hand and placed dedup in separate buckets. A held sighting must not
        # be able to claim the placed slot, or the moment the wearer actually put
        # the thing down would be suppressed as a duplicate -- turning the one
        # sighting worth keeping into the one sighting dropped.
        fresh = []
        suppressed = []
        for d in detections:
            item_identity = d.get("enrolled_item_id") or d["class_id"]
            placement = d.get("placement", "placed")
            k = (user_key, item_identity, placement)
            last = self._last_item_seen.get(k)
            # Two different clocks, deliberately. `k` is when this KIND of
            # sighting was last WRITTEN, and drives the dedup window. The held
            # STATE below is when the item was last actually seen in a hand, and
            # drives the move rule. Folding them together made an item held
            # continuously push its own write clock forward on every frame, so
            # the window never elapsed and a second pick-up was never logged.
            held_state_k = (user_key, item_identity, "_held_at")
            last_held = self._last_item_seen.get(held_state_k)
            # "It is in a hand" is STATE, not a log entry, and it must track
            # reality even when the sighting itself is a duplicate. Otherwise the
            # window silently breaks the move rule below: the phone was recorded
            # in hand at 12:20:36 and put down at 12:21:01, and when it was
            # carried to another room at 12:27 that pick-up fell inside the
            # fifteen minutes, was suppressed, and never advanced last_held. The
            # put-down in the new room then looked like a repeat of the old one
            # and produced nothing at all, even though the tile scan had found
            # the phone on the bed at 0.749.
            if placement == "in_hand":
                self._last_item_seen[held_state_k] = now_ts
                last_held = now_ts
            # Picked up since we last recorded it down? Then this is a new place.
            moved = (placement == "placed" and last is not None
                     and last_held is not None and last_held > last)

            # ...or it is simply somewhere else, whether or not a hand was seen.
            #
            # The rule above needs the pick-up to have been CAUGHT. A hand
            # closing round a phone hides most of it, the frames that catch the
            # carry are few, and if none of them produced an in_hand sighting
            # then the put-down in the new place looks like a repeat of the old
            # one and is suppressed for fifteen minutes. That is what happened on
            # 5 October: the phone moved at 04:06, nothing was logged until
            # 04:20, and the monitor called it left behind at 04:09.
            #
            # Position is weaker evidence than a hand, because this camera is on
            # the wearer and turning their head moves everything in frame. So it
            # only counts when the boxes do not overlap AT ALL and the previous
            # sighting is recent enough that the two describe the same scene.
            # A head turn that drops overlap to zero is usually also a change of
            # view, and the next sighting re-anchors it either way: the cost of
            # being wrong is one extra memory, against a false "you left it
            # behind" for the cost of being right.
            if not moved and placement == "placed" and last is not None:
                prev_box = self._last_item_box.get(k)
                if prev_box and (now_ts - last) <= MOVED_SPOT_MAX_AGE:
                    if self._box_iou(d.get("bbox") or {}, prev_box) <= MOVED_SPOT_IOU:
                        moved = True
                        print(f"[Items] {d.get('matched_item', d['name'])} is in a "
                              f"different place from where it was recorded; "
                              f"treating it as moved")
            # Held sightings cost no keyframe and no disk, so they are rate
            # limited only enough to stop a row per frame. Keeping them frequent
            # is what lets the monitor tell "carried away" from "left behind".
            window = ITEM_HELD_DEDUP_SECONDS if placement == "in_hand" else ITEM_DEDUP_SECONDS
            if last is None or (now_ts - last) >= window or moved:
                self._last_item_seen[k] = now_ts
                # Remembered so the next sighting can tell "still there" from
                # "somewhere else" without needing to have seen a hand.
                if d.get("bbox"):
                    self._last_item_box[k] = dict(d["bbox"])
                if moved:
                    print(f"[Items] {d.get('matched_item', d['name'])} was carried "
                          f"and put down again; recording where it is now")
                fresh.append(d)
            else:
                suppressed.append(d.get("matched_item", d["name"]))
                # Suppression used to write nothing at all, and that is why an
                # alert could not be immediate. A phone sitting in view on the
                # desk in front of a seated wearer and a phone two floors away
                # produced identical records: one sighting, then silence. The
                # only way to be sure the wearer had gone was to wait ten
                # minutes.
                #
                # A suppressed sighting still means "it is still here, I can see
                # it". Stamping that onto the existing event is one small update
                # instead of a keyframe write plus an insert, so the dedup gate
                # keeps doing its job for storage while absence becomes
                # measurable in seconds. No room is involved.
                self._touch_item_visibility(user_key, item_identity, placement)

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
        # Unmatched detections have no identity behind them, so the ONLY thing
        # vouching for them is the detector's confidence. They keep the original
        # bar: the lowered one exists so the gallery gets a look at faint boxes,
        # not so faint boxes can become suggestions. Without this, dropping the
        # candidate bar would flood the enrolment screen with 0.08 guesses.
        unmatched = [d for d in detections
                     if not d.get("matched_item") and d.get("confidence", 0) >= _conf]

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
        #
        # A frame is stored only when something in it was actually PUT DOWN.
        # This is the complaint itself: every frame under objects showed the
        # wearer holding their phone, because a frame was stored whenever an
        # item was matched, whatever the placement said. in_hand sightings are
        # still recorded in the database -- the left-behind check needs them to
        # know the item was carried, and they are what resets the fifteen-minute
        # window -- but they are not memories of where anything was left, so
        # they get no picture and never reach the feed.
        import uuid
        placed_now = [d for d in detections if d.get("placement") == "placed"]
        # ── One frame per place ──────────────────────────────────────────────
        #
        # A belonging resting in one spot was keeping several frames of that one
        # spot: 01:05:35, :40 and :54 all stored a picture of the phone at the
        # identical box (377,518)-(519,600), and 02:28:36 and :37 stored two
        # more a second apart. The memory page then fills with the same shelf
        # photographed over and over.
        #
        # The window gate above cannot prevent this on its own. It keys on
        # time.monotonic() inside the worker, which is PROCESSING time, while
        # frames are queued and may be handled far apart and in a process that
        # has since been replaced -- and its state is gone with it. Asking the
        # database what was last stored survives all of that.
        #
        # A put-down whose box lands where this item's last stored put-down was
        # is the same place, not a new one, so it needs no second picture.
        placed_now = [d for d in placed_now if not self._already_have_this_spot(user_key, d)]
        item_keyframe_id = str(uuid.uuid4()) if placed_now else None
        try:
            storage = self._get_item_storage()
            if storage is not None and item_keyframe_id is not None:
                # The image here is the SHARP one, so the detectors work under
                # Privacy Mode's blur. ItemStorage.save blurs what it writes.
                storage.save(item_keyframe_id, image, {
                    **(metadata or {}),
                    "user_id": user_key,
                    "type": "item_detection",
                    # Only what was put down. The frame is a record of where
                    # these were left, and naming a held item here would put it
                    # back into the feed by the side door.
                    "items": sorted({d.get("matched_item", d["name"]) for d in placed_now}),
                    "matched_count": len(placed_now),
                })
        except Exception as e:
            print(f"[DailyItemIndexer] Error saving item evidence keyframe: {e}")

        if item_keyframe_id:
            print(f"[DailyItemIndexer] Keyframe {item_keyframe_id}: Detected {len(detections)} items ({', '.join(item_names)}){match_str} in {elapsed_ms:.1f}ms{extra}")
        else:
            states = ', '.join(f"{d.get('matched_item', d['name'])}={d.get('placement')}" for d in detections)
            print(f"[DailyItemIndexer] Nothing put down, so no frame kept ({states}) in {elapsed_ms:.1f}ms{extra}")

        # Persist to MongoDB referencing the exact item_keyframe_id
        self._persist_to_db(item_keyframe_id, detections, item_names, metadata)

    def _already_have_this_spot(self, user_key, det) -> bool:
        """Is there already a stored frame of this belonging in this place?

        Compares against the last PUT-DOWN of this item that actually kept a
        frame, read from the database so a restarted worker still knows. Returns
        False on any problem: a duplicate picture is a smaller harm than losing
        the record of where something was left.
        """
        iid = det.get("enrolled_item_id")
        box = det.get("bbox")
        if not iid or not box:
            return False
        try:
            from bson import ObjectId
            db = get_client()[get_db_name()]
            try:
                uid = ObjectId(user_key)
            except Exception:
                return False
            # EVERY recent put-down of this item, not just the newest one.
            #
            # This asked for the single latest row by capture time, and frames
            # are not processed in the order they were captured. At 01:23:07 a
            # re-run of the 01:22:52 frame asked this question; the newest row
            # was the 01:23:06 capture, by then at (697,539) because the phone
            # had been moved, so the overlap was nil and the duplicate passed --
            # while its own twin at (836,542) sat one row further back. Reading
            # the window instead of its newest member is what makes the check
            # independent of processing order.
            now = datetime.now(timezone.utc)
            cutoff = now - timedelta(seconds=ITEM_DEDUP_SECONDS)
            prev = db.eventlogs.find(
                {"user_id": uid, "event_type": "object", "keyframe_id": {"$ne": None},
                 "timestamp": {"$gte": cutoff},
                 "details.items": {"$elemMatch": {
                     "enrolled_item_id": str(iid), "placement": "placed"}}},
                {"details.items": 1, "timestamp": 1}).sort("timestamp", -1).limit(
                    SAME_SPOT_LOOKBACK)
            for row in prev:
                age = (now - row["timestamp"].replace(
                    tzinfo=row["timestamp"].tzinfo or timezone.utc)).total_seconds()
                for it in (row.get("details", {}) or {}).get("items") or []:
                    if str(it.get("enrolled_item_id")) != str(iid):
                        continue
                    if it.get("placement") != "placed" or not it.get("bbox"):
                        continue
                    o = self._box_iou(box, it["bbox"])
                    same = o >= SAME_SPOT_IOU or (
                        o >= SAME_SPOT_DRIFT_IOU and age <= SAME_SPOT_DRIFT_SECONDS)
                    if same:
                        why = ("the same box" if o >= SAME_SPOT_IOU
                               else f"the same box give or take drift, {age:.0f}s later")
                        print(f"[Items] {det.get('matched_item', det.get('name'))} is in {why} "
                              f"(overlap {o:.2f}); keeping the frame already stored rather than "
                              f"another of the same place")
                        return True
        except Exception as e:
            print(f"[Items] same-spot check skipped: {e}")
        return False

    def _touch_item_visibility(self, user_key, item_identity, placement):
        """Record that a suppressed item is still in view, on its existing event.

        Written as an update to the newest event for that belonging, not as a new
        event, so the dedup gate still prevents the flooding it exists to
        prevent while absence becomes measurable in seconds instead of minutes.

        Cheap by construction: one indexed update, no keyframe, no insert. Never
        raises -- a missed refresh only costs freshness, and the alert path falls
        back to the sighting timestamp, which is the old behaviour.
        """
        try:
            from bson import ObjectId
            client = get_client()
            db = client[get_db_name()]
            try:
                uid = ObjectId(user_key)
            except Exception:
                return
            # The newest event is resolved first and then updated by _id.
            # update_one(..., sort=...) only exists on PyMongo 4.7 with a
            # MongoDB 8 server, and silently doing the wrong document here would
            # stamp freshness onto an old sighting.
            latest = db.eventlogs.find_one(
                {"user_id": uid, "event_type": "object",
                 "details.items.enrolled_item_id": str(item_identity)},
                {"_id": 1}, sort=[("timestamp", -1)])
            if not latest:
                return
            db.eventlogs.update_one(
                {"_id": latest["_id"]},
                {"$set": {"details.last_visible_at": datetime.now(timezone.utc),
                          "details.last_visible_placement": placement}})
        except Exception as e:
            print(f"[Items] visibility refresh skipped: {e}")

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

            cursor = db.useritems.find(
                query, {"item_name": 1, "item_embeddings": 1, "detector_class": 1})
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

                    # A FLOOR for this item, not a replacement for the class
                    # rules, and only when the item has earned one. It used to be
                    # set unconditionally to 0.72 or EXEMPLAR_MATCH_THRESHOLD,
                    # and because the matcher only consults the class when this
                    # is None, that made CLASS_AGREE and CLASS_DISAGREE dead code
                    # for every item that has ever existed. The consequence was
                    # on the wearer's own frames: a box YOLO called "Laptop"
                    # matched the Phone at 0.750, because 0.750 clears 0.74, and
                    # the 0.85 bar meant for a disagreeing class never ran. It is
                    # also exactly the "Mouse -> Phone at 0.798" the comments
                    # above record as already fixed.
                    item_floor = 0.72 if mean_internal_sim >= 0.96 else None

                    items.append({
                        "id": str(doc["_id"]),
                        "name": doc.get("item_name", "Unknown Item"),
                        # What this detector calls this item, measured on its
                        # own enrolment photos rather than guessed from its name.
                        "detector_class": doc.get("detector_class"),
                        "embeddings": embs_arr,
                        "threshold_floor": item_floor,
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
            # The runner-up, so a box that two belongings both claim can be
            # recognised as telling us nothing. See AMBIGUOUS_MARGIN below.
            second_sim = 0.0
            second_name = None

            for item in user_items:
                # YOLO named this box. Whether that name describes this item
                # moves the bar in BOTH directions: down when it agrees, which
                # is the one path with no observed false positives, and up when
                # it plainly does not, which is where every observed false
                # positive came from. This is the BASE bar and it always applies;
                # it was previously skipped whenever the item carried a stored
                # threshold, which was always, so it never applied at all.
                # Agreement is a fact about the DETECTOR, not about English.
                # Objects365 boxes a pair of earbuds as "Mouse", which overlaps
                # no word in "Rover Earbuds", so the name test called it a
                # disagreement and raised the bar to 0.85 -- a bar those
                # earbuds could never clear however well they were embedded.
                # The class measured on their own enrolment photos is what
                # settles it; the name test stays as a fallback for items
                # enrolled before that was recorded.
                _cls = d.get("name", "")
                _agrees = (self._names_agree(_cls, item["name"])
                           or (item.get("detector_class")
                               and _cls == item["detector_class"]))
                thresh = (self.CLASS_AGREE_MATCH_THRESHOLD if _agrees
                          else self.CLASS_DISAGREE_MATCH_THRESHOLD)
                # An item with almost no surface texture matches ambient clutter
                # too easily, so it carries a floor of its own. A floor can only
                # raise the bar, never lower it below what the class demands.
                floor = item.get("threshold_floor")
                if floor:
                    thresh = max(thresh, floor)
                # Faint boxes must prove themselves harder. Candidates now come
                # in from ENROLLED_CANDIDATE_CONF rather than conf_threshold, so
                # the gallery sees boxes the detector barely believes in, and on
                # those the ordinary bar is too generous: over the 04:40-04:50
                # window the two real put-downs scored 0.885 and 0.891 while the
                # marginal junk scored 0.663 and 0.666, straddling this bar
                # exactly. One source of evidence being weak is a reason to
                # demand more of the other, not to shrug.
                if d.get("confidence", 1.0) < self.conf_threshold:
                    thresh = max(thresh, LOW_CONF_MATCH_THRESHOLD)
                sims = np.asarray(item["embeddings"]) @ crop_emb
                sim = float(sims.max()) if sims.size else 0.0
                if sim >= thresh:
                    if sim > best_sim:
                        second_sim, second_name = best_sim, best_match_name
                        best_sim = sim
                        best_match_name = item["name"]
                        best_item_id = item["id"]
                        best_thresh = thresh
                    elif sim > second_sim:
                        second_sim, second_name = sim, item["name"]

            # Two belongings claiming the same pixels is not a match, it is a
            # coin toss.
            #
            # One tile_scan box was matched as the wearer's Phone at 0.770 and
            # their Rover Earbuds at 0.763, seven thousandths apart. Whichever
            # won, the system would have asserted a specific object was in a
            # specific place on the strength of nothing. Galleries of fifteen
            # varied photographs overlap this much: measured on this account, the
            # car keys reach 0.860 into the phone's gallery.
            #
            # Refusing is the honest outcome. A missed sighting is a gap in the
            # record; a confident wrong one sends somebody looking for the wrong
            # thing in the wrong room.
            if best_match_name and second_name and (best_sim - second_sim) < AMBIGUOUS_MARGIN:
                print(f"[DailyItemIndexer] Ambiguous: '{d.get('name','?')}' matched "
                      f"'{best_match_name}' at {best_sim:.3f} and '{second_name}' at "
                      f"{second_sim:.3f}; too close to call, so neither is claimed")
                best_match_name = None
                best_item_id = None

            if best_match_name:
                generic_name = d["name"]
                d["matched_item"] = best_match_name
                d["enrolled_item_id"] = best_item_id
                d["exemplar_similarity"] = round(best_sim, 3)
                d["generic_name"] = generic_name
                d["name"] = best_match_name
                print(f"[DailyItemIndexer] Exemplar MATCH: '{generic_name}' -> '{best_match_name}' (sim={best_sim:.3f} >= {best_thresh})")

        # ── One belonging cannot be in two places in one frame ───────────────
        #
        # A single keyframe matched the wearer's phone TWICE: once at 0.168 of
        # the frame scoring 0.750, and once at 0.013 scoring 0.866. One of those
        # is the phone and the other is something that resembles it, and keeping
        # both is worse than keeping either, because the two carry opposite
        # placements. The large one was read as "in hand" and the small one as
        # "put down", and that contradiction drove everything the wearer
        # reported: the spurious pick-up made the next genuine put-down look
        # like a move, so it bypassed the fifteen-minute window and stored
        # another frame -- five of them -- and the newest sighting kept reading
        # in_hand, which tells the left-behind check the item was carried away
        # and no alert is needed.
        #
        # The strongest match wins. Lowering the candidate bar to find distant
        # belongings is what made duplicates common enough to matter: more boxes
        # reach the gallery, so the same object is now offered to it several
        # times over.
        best_per_item: dict[str, dict] = {}
        for d in detections:
            iid = d.get("enrolled_item_id")
            if not iid:
                continue
            prev = best_per_item.get(str(iid))
            if prev is None or d.get("exemplar_similarity", 0) > prev.get("exemplar_similarity", 0):
                best_per_item[str(iid)] = d
        for d in detections:
            iid = d.get("enrolled_item_id")
            if iid and best_per_item.get(str(iid)) is not d:
                print(f"[DailyItemIndexer] dropping a weaker second match for "
                      f"{d.get('matched_item')} in the same frame "
                      f"(sim={d.get('exemplar_similarity')} vs "
                      f"{best_per_item[str(iid)].get('exemplar_similarity')})")
                for k in ("matched_item", "enrolled_item_id", "exemplar_similarity"):
                    d.pop(k, None)
                d["name"] = d.get("generic_name", d.get("name"))

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

    def _persist_to_db(self, keyframe_id: str | None, detections: list[dict], item_names: list[str], metadata: dict):
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
            # "Spotted", not "Left". Seeing a phone resting on a desk while its
            # owner is standing right there is a SIGHTING. "Left" is a claim
            # about departure, and nothing in a single frame can support it: it
            # needs the wearer to have moved away and the item not to have been
            # seen since, which only the routine monitor can know. Saying "Left
            # Phone here" on every placed sighting cried wolf on every glance.
            all_placed = bool(detections) and all(
                d.get("placement") == "placed" for d in detections)
            summary_str = f"Spotted {', '.join(item_names[:4])}"
            if len(item_names) > 4:
                summary_str += f" and {len(item_names) - 4} more"

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

    @staticmethod
    def _box_iou(a: dict, b: dict) -> float:
        ox = max(0, min(a["x2"], b["x2"]) - max(a["x1"], b["x1"]))
        oy = max(0, min(a["y2"], b["y2"]) - max(a["y1"], b["y1"]))
        inter = ox * oy
        aa = max(0, a["x2"] - a["x1"]) * max(0, a["y2"] - a["y1"])
        ab = max(0, b["x2"] - b["x1"]) * max(0, b["y2"] - b["y1"])
        union = aa + ab - inter
        return inter / float(union) if union > 0 else 0.0

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
            boxes = list(result.get("all_hand_bboxes") or [])
            if boxes:
                return boxes
            # Nothing found. That is reported as "looked, saw no hands", which
            # the caller reads as real evidence the item is NOT held -- so a miss
            # here becomes a wrong "put down" and stores the wrong frame.
            #
            # MediaPipe misses hands in low light, and these are indoor evening
            # frames. Measured on a frame with two hands wrapped round the phone
            # (mean luminance 86.7): the original found 0 hands at every
            # confidence down to 0.1, and gamma-brightening recovered the right
            # hand at (744,416)-(1063,722), which is where it actually is. CLAHE
            # did not help on that frame and cost up to 2.3 s. Gamma costs 6 ms
            # plus one more detection pass (~300 ms), and only on frames that
            # found nothing, which are exactly the frames currently getting the
            # answer wrong.
            bright = self._brighten(image)
            retry = self._gesture.analyze_frame(bright)
            retry_boxes = list(retry.get("all_hand_bboxes") or [])
            if retry_boxes:
                print(f"[Items] hands found only after brightening: {len(retry_boxes)}")
            return retry_boxes
        except Exception as e:
            if not getattr(self, "_warned_no_hands", False):
                print(f"[DailyItemIndexer] hand detector unavailable, every item "
                      f"will be recorded as put down: {e}")
                self._warned_no_hands = True
            return None

    # How many confidently-labelled sightings a belonging needs, of EACH kind,
    # before its own size threshold is trusted. Three is small, but these labels
    # come only from frames where hands were actually seen, so they accumulate
    # slowly and a higher bar would leave the fallback inert for weeks.
    _SIZE_MIN_SAMPLES = 3
    _SIZE_CACHE_SECONDS = 300.0

    def _held_size_threshold(self, user_key, item_identity):
        """How big this particular belonging looks when held, as a frame fraction.

        Returns the midpoint between its own median held size and its own median
        put-down size, or None when it has not been seen enough of both ways.
        None means "no opinion", and the caller records `unknown` rather than
        guessing, which is the whole point of doing this per item: a laptop on a
        desk is larger than a phone in a hand, so one global number cannot serve
        both and a previous global rule called exactly that laptop "held".

        Only sightings where hands were actually SEEN are used, because those are
        the only labels not produced by this rule itself. Feeding its own output
        back in would let one mistake harden into a threshold.
        """
        key = (user_key, str(item_identity))
        now_ts = time.monotonic()
        if not hasattr(self, "_size_cache"):
            self._size_cache = {}
        hit = self._size_cache.get(key)
        if hit and (now_ts - hit[0]) < self._SIZE_CACHE_SECONDS:
            return hit[1]

        thr = None
        try:
            from bson import ObjectId
            db = get_client()[get_db_name()]
            try:
                uid = ObjectId(user_key)
            except Exception:
                uid = None
            if uid is not None:
                sizes = {"in_hand": [], "placed": [], "unlabelled": []}
                # EVERY sighting of this belonging, not only the confidently
                # labelled ones: the labelled two feed the precise threshold, and
                # all of them together feed the bootstrap below.
                cur = db.eventlogs.find(
                    {"user_id": uid, "event_type": "object",
                     "details.items.enrolled_item_id": str(item_identity)},
                    {"details.items": 1}).sort("timestamp", -1).limit(200)
                for ev in cur:
                    for it in (ev.get("details", {}).get("items") or []):
                        if str(it.get("enrolled_item_id")) != str(item_identity):
                            continue
                        a = it.get("area_frac")
                        if not isinstance(a, (int, float)):
                            continue
                        p = it.get("placement")
                        if it.get("hands_seen") and p in ("in_hand", "placed"):
                            sizes[p].append(float(a))
                        else:
                            sizes["unlabelled"].append(float(a))
                # Bootstrap, when there are not yet three confident labels of
                # each kind. Waiting for them stalls: a `placed` label only
                # comes from a frame where hands were seen and did NOT cover the
                # item, which is the ambiguous case, so the real database sat at
                # three in_hand and one placed and the threshold stayed None --
                # leaving the 04:34 misclassification unfixed in practice.
                #
                # The sizes alone carry the signal without needing labels: a
                # belonging that is sometimes held and sometimes put down is
                # large in some frames and small in others, and the split is the
                # threshold. Same per-item reasoning, same refusal to guess when
                # the two clusters are not clearly apart.
                unlabelled = sizes["in_hand"] + sizes["placed"] + sizes["unlabelled"]
                if (len(sizes["in_hand"]) < self._SIZE_MIN_SAMPLES
                        or len(sizes["placed"]) < self._SIZE_MIN_SAMPLES) and len(unlabelled) >= 4:
                    srt = sorted(unlabelled)
                    lo = statistics.median(srt[:max(1, len(srt) // 3)])
                    hi = statistics.median(srt[-max(1, len(srt) // 3):])
                    if hi > lo * 3:          # a clear gap, not gentle variation
                        thr = (hi * lo) ** 0.5
                        print(f"[Items] size threshold for {item_identity} from {len(unlabelled)} "
                              f"unlabelled sightings: small~{lo:.3f} large~{hi:.3f} -> {thr:.3f}")
                        self._size_cache[key] = (now_ts, thr)
                        return thr

                if (len(sizes["in_hand"]) >= self._SIZE_MIN_SAMPLES
                        and len(sizes["placed"]) >= self._SIZE_MIN_SAMPLES):
                    held_med = statistics.median(sizes["in_hand"])
                    down_med = statistics.median(sizes["placed"])
                    # Only meaningful if held really is the larger of the two.
                    # A belonging that looks the same either way (something small
                    # always at arm's length) gets no threshold rather than a
                    # coin toss.
                    if held_med > down_med * 1.5:
                        thr = (held_med * down_med) ** 0.5      # geometric midpoint
                        print(f"[Items] size threshold for {item_identity}: "
                              f"held~{held_med:.3f} placed~{down_med:.3f} -> {thr:.3f} "
                              f"(from {len(sizes['in_hand'])}+{len(sizes['placed'])} labelled sightings)")
        except Exception as e:
            print(f"[Items] size calibration unavailable: {e}")

        self._size_cache[key] = (now_ts, thr)
        return thr

    # Gamma 1.6, applied only when a first detection pass found nothing. 2.2 was
    # also tried and found the same single hand, so the gentler curve is used.
    _GAMMA_LUT = None

    def _brighten(self, image):
        """A brighter copy of the frame, for a second look at a dark one."""
        if DailyItemIndexer._GAMMA_LUT is None:
            DailyItemIndexer._GAMMA_LUT = np.array(
                [((i / 255.0) ** (1.0 / 1.6)) * 255 for i in range(256)]).astype("uint8")
        return cv2.LUT(image, DailyItemIndexer._GAMMA_LUT)

    def _is_held(self, bbox: dict, hand_boxes: list[dict] | None,
                 frame_w: int, frame_h: int) -> bool:
        """Is this item in the wearer's hand right now?

        Decided by the hands, and only by the hands. An earlier version also
        called anything filling 30% of the frame "held", on the reasoning that
        it must be right at the camera. On real frames that rule fired on a
        laptop sitting on a desk, and the log said so in one line:

            [Items] c2f03780 -> ['Laptop', 'Cell Phone'] | hands seen 0
            [Items] Laptop is in hand, not recorded as put down

        No hands were in frame and it was still called held, so the laptop was
        never recorded as put down. A detector that looked and saw no hands is
        evidence, and overruling it by bounding-box size contradicted the only
        measurement being taken.
        """
        if not hand_boxes:
            return False      # [] is real evidence; None was handled by caller

        x1, y1, x2, y2 = bbox["x1"], bbox["y1"], bbox["x2"], bbox["y2"]
        area = max(1, (x2 - x1) * (y2 - y1))
        pad = int(ITEM_HELD_NEAR_FRAC * frame_w)
        for hb in hand_boxes:
            hx1, hy1 = hb["x1"] - pad, hb["y1"] - pad
            hx2, hy2 = hb["x2"] + pad, hb["y2"] + pad
            ox = max(0, min(x2, hx2) - max(x1, hx1))
            oy = max(0, min(y2, hy2) - max(y1, hy1))
            if (ox * oy) / float(area) >= ITEM_HELD_OVERLAP_FRAC:
                return True
        return False

    @staticmethod
    def _surviving_frame(session: dict) -> str | None:
        """The session's best frame that is STILL ON DISK, or None.

        A session closes a couple of minutes after its last frame, and a frame
        caught on the way into a private room is destroyed in between. One
        bedroom session was written at 17:17:32 carrying a frame deleted at
        17:15:5x, so the feed showed "Time in the bedroom for 1 min" with a
        picture that did not exist -- and the purge could not have redacted the
        row, because the row was not written yet.
        """
        roots = [os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "..", "..", "keyframe_backend", d)
                 for d in ("keyframe_storage", "activities_storage")]
        best = session.get("keyframe_id")
        # Best first, then the runners-up the tracker kept for exactly this.
        for kid in [best] + [k for k in (session.get("keyframe_candidates") or [])
                             if k != best]:
            if not kid:
                continue
            for root in roots:
                if glob.glob(os.path.join(root, "*", "*", f"{kid}.jpg")):
                    return kid
        return None

    @staticmethod
    def _captured_epoch(metadata: dict) -> float:
        """When the frame in this metadata was CAPTURED, as a unix timestamp.

        Falls back to now, which makes a purge reach no further back than this
        instant -- the conservative direction: it may leave a frame of the
        private room on disk, where guessing earlier would delete frames of the
        room before it.
        """
        raw = (metadata or {}).get("timestamp")
        if isinstance(raw, str) and raw:
            try:
                dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt.timestamp()
            except ValueError:
                pass
        return time.time()

    # ── Environment sessions ─────────────────────────────────────────────────
    def _observe_scene(self, all_detections: dict[str, float], user_id_str: str,
                       keyframe_id: str, metadata: dict):
        """Feed one keyframe's raw Objects365 detections to the scene tracker.

        Emits an event only when a session CLOSES, so the feed carries
        "Kitchen activity for 25 minutes" rather than a label per frame.

        Returns True when this room is one the wearer asked never to be
        recorded in, which means the caller must stop: nothing further about
        this frame may be stored.
        """
        if not user_id_str:
            return False
        try:
            from ai.scene import classify_scene, SceneSessionTracker
        except Exception as e:
            print(f"[DailyItemIndexer] scene module unavailable: {e}")
            return False

        tracker = self._scene_trackers.get(user_id_str)
        if tracker is None:
            tracker = SceneSessionTracker()
            self._scene_trackers[user_id_str] = tracker

        room, score, scores = classify_scene(all_detections)

        # ── The washroom rule (Module A FE-5) ────────────────────────────────
        #
        # This is the earliest moment anything in the system knows which room
        # the wearer is in, and it is already too late: the frame being
        # classified was written to disk seconds ago by the capture loop, a
        # thumbnail may have been rendered from it, and an event row points at
        # it. So recognising a sensitive room does two things, and the second
        # matters more than the first -- it closes the gate on what comes next,
        # and destroys what has already been kept.
        #
        # Checked before the session tracker sees it, so no bathroom session is
        # ever opened, named, or given a cover photograph.
        try:
            from ai.privacy import (is_sensitive_room, enter_sensitive_room,
                                    left_sensitive_room)
            if is_sensitive_room(user_id_str, room):
                # The CAPTURE time, not now. Classification runs behind the
                # capture loop, so "now" would place the boundary seconds late
                # and leave the first frames of the visit on disk; and a purge
                # measured backwards from now took the previous room's frames,
                # which is how a wearer lost their bedroom by walking into the
                # washroom.
                print(f"[Privacy] {room} recognised ({score:.2f}); going dark "
                      f"and destroying what this visit already stored")
                enter_sensitive_room(user_id_str, room,
                                     self._captured_epoch(metadata))
                return True
            if room:
                # A room was named and it is not a private one, so the wearer
                # has left. Only ever called with a RECOGNISED room: lifting on
                # "no room recognised" would let any unclassifiable frame from
                # inside the washroom reopen the gate.
                left_sensitive_room(user_id_str, room)
        except Exception as e:
            print(f"[Privacy] sensitive-room check skipped: {e}")

        # A probe's whole job was the question above. It must not reach the
        # session tracker: its frame was never written to disk, so it would
        # contribute to a room session and could be chosen as that session's
        # cover photograph, leaving an event pointing at an image that does not
        # exist. Returning False, because a probe never means "stop" -- by here
        # the room is either still private (handled above) or no longer is.
        if (metadata or {}).get("privacy_probe"):
            return False

        # One line per indexed frame saying what was seen and what was decided.
        # "Nothing was recognised" had been indistinguishable from "Tier-2 never
        # ran" and "the room was recognised but the session has not closed yet",
        # which need entirely different fixes and cannot be told apart from the
        # database afterwards.
        try:
            from ai.scene import explain_scene
            top = ", ".join(f"{k}={v:.2f}" for k, v in sorted(
                all_detections.items(), key=lambda kv: -kv[1])[:6]) or "nothing"
            if room:
                live = {r: round(s, 2) for r, s in scores.items() if s > 0}
                print(f"[Scene] {str(keyframe_id)[:8]} -> {room} ({score:.2f}) "
                      f"| rooms {live} | saw {top}")
            else:
                print(f"[Scene] {str(keyframe_id)[:8]} -> no room: "
                      f"{explain_scene(all_detections)} | saw {top}")
        except Exception:
            pass

        ts = time.time()
        session = tracker.observe(room, all_detections, ts,
                                  keyframe_id=keyframe_id, score=score)
        if session:
            # The session's OWN best frame, and one that still EXISTS. Passing
            # the frame in hand here attached the next room's photo to every
            # session that closed; passing the best one blindly attached a
            # photo that privacy had already destroyed.
            self._persist_scene_session(
                session, user_id_str, self._surviving_frame(session))

        # A room is reported when the wearer LEAVES it, with the time spent
        # there, and not before. Writing the session while it was still open
        # meant a stretch in one room produced a record that kept being rewritten
        # as it grew, so the feed carried "Time in the bedroom for 1 min" while
        # the wearer was still sitting in the bedroom. The event people want is
        # "you were in the kitchen for twelve minutes", and that sentence cannot
        # be written until the visit is over.
        #
        # flush_scene_sessions() closes whatever is open when the stream stops,
        # so the final room of a run is still recorded.

    def flush_scene_sessions(self, user_id_str: str | None = None):
        """Close open sessions, e.g. when a stream stops."""
        targets = [user_id_str] if user_id_str else list(self._scene_trackers)
        for uid in targets:
            tracker = self._scene_trackers.get(uid)
            if not tracker:
                continue
            session = tracker.flush()
            if session:
                self._persist_scene_session(session, uid,
                                            self._surviving_frame(session))

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
    def _corroborated_tiles(self, tiles, boxed, image):
        """A tile match needs a reason to be believed beyond its own score.

        The tile scanner slices the frame into fixed squares and asks whether
        each one resembles an enrolled belonging. It has no object boundary, so
        a square holding a television, a computer mouse or a stretch of desk is
        compared whole against galleries of whole photographs, and it scores the
        way a real sighting scores. Every number available says the same thing:

            4 Oct 04:05:36  Car Keys   0.747  hands, 2 detector boxes  CORRECT
            5 Oct 01:25:18  Phone      0.745  nothing else in frame    a TV

        Two thousandths apart, so no threshold can separate them. What separates
        them is the rest of the frame. A belonging is put down where the wearer
        IS: their hands are in shot, or the detector has boxed something else
        nearby. A television across the room has neither.

        This refuses rather than lowers confidence, because a stored frame of
        somebody's living room labelled "your phone is here" is worse than no
        sighting at all: it sends them to the wrong room.
        """
        if not tiles:
            return tiles
        # Anything the real detector boxed and matched in this same frame.
        corroborating = [d for d in boxed if d.get("generic_name") != "tile_scan"]
        if corroborating:
            return tiles
        try:
            hands = self._hand_boxes(image)
        except Exception:
            hands = None
        if hands:
            return tiles
        for t in tiles:
            print(f"[DailyItemIndexer] Tile match '{t.get('matched_item')}' "
                  f"({t.get('exemplar_similarity')}) has nothing else in frame to "
                  f"support it, no hands and no detected object; not recording it")
        return []

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


def _gamma(image_bgr: np.ndarray, g: float) -> np.ndarray:
    """Brighten (g<1) or darken (g>1) the way a room's lighting does.

    Gamma, not a linear scale, because that is how exposure actually behaves:
    it moves the mid-tones while leaving black and white roughly in place, so
    the object keeps its shape instead of washing out or crushing to a
    silhouette.
    """
    table = np.array([((i / 255.0) ** g) * 255 for i in range(256)], dtype=np.uint8)
    return cv2.LUT(image_bgr, table)


def _rotate(image_bgr: np.ndarray, degrees: float) -> np.ndarray:
    """Rotate in-plane, replicating the border.

    Filling with black would put hard artificial edges into the crop, and
    MobileNetV3 would embed those edges as if they were part of the object.
    """
    h, w = image_bgr.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), degrees, 1.0)
    return cv2.warpAffine(image_bgr, m, (w, h), flags=cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def _clahe(image_bgr: np.ndarray) -> np.ndarray:
    """Local contrast lift, which is what a dim room does to a small object."""
    lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8)).apply(l)
    return cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2BGR)


def augment_for_enrollment(image_bgr: np.ndarray) -> list[np.ndarray]:
    """One enrollment photo, expanded to cover the conditions it will be seen in.

    The gallery is matched by cosine similarity against a crop from a wearable
    camera, so it has to span the LIGHTING and the ANGLE that camera will
    actually encounter. Asking the wearer for more photos does not solve that:
    they take them in one room, at one time of day, and the phone is then
    carried into every other lighting in the house.

    Measured motivation: the wearer's Phone gallery, four photos taken together,
    agreed with ITSELF at a mean cosine of only 0.699 while the matcher demanded
    0.74, and a computer mouse under different light scored 0.798 against it.
    The gallery was not covering the space it needed to cover.

    Lighting and rotation are varied mostly independently rather than crossed,
    to keep enrollment fast; two combined variants cover the corner where a
    dim room and an odd angle happen together.
    """
    out = [image_bgr]
    for g in (0.55, 0.75, 1.35, 1.8):
        out.append(_gamma(image_bgr, g))
    out.append(_clahe(image_bgr))
    for deg in (-12.0, 12.0):
        out.append(_rotate(image_bgr, deg))
    out.append(_gamma(_rotate(image_bgr, -12.0), 0.7))
    out.append(_gamma(_rotate(image_bgr, 12.0), 1.4))
    return out


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
