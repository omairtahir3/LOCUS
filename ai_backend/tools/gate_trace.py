"""Every gate between a camera frame and a memory, and what each one drops.

    python ai_backend/tools/gate_trace.py                  # last 6 hours
    python ai_backend/tools/gate_trace.py 24               # last 24 hours
    python ai_backend/tools/gate_trace.py 24 "Rover Earbuds"

Why this exists. A sighting can die at eighteen different places on the way to
Memory Search, and each one reports itself differently or not at all. Chasing
them one wearer-report at a time found five separate causes in a day -- a faint
box bar, a staleness cutoff, a position gate, size asserting a grasp, and a
pipeline with no medication context -- each fix real and each followed by the
next failure. This walks the whole path at once and says where the losses are.

It is a DIAGNOSTIC, not a test: no assertions, no pass or fail. It reads stored
frames and the event log, and writes nothing.

What it cannot see. Three gates act before a frame reaches disk, so their
losses leave no artefact to measure: the capture cooldown, the queue's
high-water drop, and the staleness cutoff on dequeue. Their configured values
are printed, and the live log is the only place their counts appear. A frame
judged in_hand likewise stores no picture, so those decisions can only be read
from the event rows, not re-derived.
"""
import datetime as dt
import glob
import os
import sys
import warnings
from collections import defaultdict

warnings.filterwarnings("ignore")

AI = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
DP = os.path.join(AI, "detection_pipeline")
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import cv2
import numpy as np
from bson import ObjectId
from pymongo import MongoClient

import ai.item_indexer as II
from ai import verifier

UID = os.environ.get("LOCUS_UID", "6a6e439595ff22c2e2f91416")
HOURS = float(sys.argv[1]) if len(sys.argv) > 1 else 6.0
ONLY = sys.argv[2] if len(sys.argv) > 2 else None
KF = os.path.join(AI, "keyframe_backend")
db = MongoClient("mongodb://127.0.0.1:27017").locusDB

idx = II.DailyItemIndexer.get_instance()
idx._ensure_model_loaded()
idx._user_items_cache = {}
back = idx._get_embedding_backbone()
items = [it for it in idx._get_user_items_cached(UID)
         if ONLY is None or it["name"] == ONLY]
have_verifier = verifier.available()
if have_verifier:
    verifier.embed([np.zeros((64, 64, 3), np.uint8)])


def norm(a):
    a = np.asarray(a, dtype=np.float32)
    return a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-9)


gal = {it["name"]: norm(it.get("enrol_embeddings")
                        if it.get("enrol_embeddings") is not None
                        else it["embeddings"]) for it in items}

print("=" * 78)
print("GATES BEFORE THE FRAME REACHES DISK  (not measurable here; see the log)")
print("=" * 78)
from keyframe_backend.keyframe import (EVENT_COOLDOWN_SECONDS, COVERAGE_SECONDS,
                                       KEYFRAME_TTL_HOURS)
print(f"  capture cooldown, scene_change   {EVENT_COOLDOWN_SECONDS['scene_change']:>7.0f} s"
      f"   a frame at most this often")
print(f"  guaranteed coverage frame        {COVERAGE_SECONDS:>7.0f} s")
print(f"  retention                        {KEYFRAME_TTL_HOURS:>7} h"
      f"   frames older than this are swept")
print(f"  INDEX_QUEUE_HIGH_WATER           {II.INDEX_QUEUE_HIGH_WATER:>7}"
      f"     oldest queued frames dropped past this depth")
print(f"  MAX_INDEX_AGE_SECONDS            {II.MAX_INDEX_AGE_SECONDS:>7.0f} s"
      f"   a frame older than this is skipped unprocessed")
print(f"  TILE_SCAN_MAX_BACKLOG            {II.TILE_SCAN_MAX_BACKLOG:>7}"
      f"     the region proposer is shed past this depth")
print("  -> look for 'skipped N frame(s) older than', 'backlog at', and")
print("     'skipping the tile scan' in the backend log for their real counts.")
print()

cut = dt.datetime.now() - dt.timedelta(hours=HOURS)
paths = sorted((p for p in glob.glob(os.path.join(KF, "*_storage", "*", "*", "*.jpg"))
                if dt.datetime.fromtimestamp(os.path.getmtime(p)) >= cut),
               key=os.path.getmtime)

print("=" * 78)
print(f"THE FUNNEL, over {len(paths)} stored frames of the last {HOURS:.0f} h"
      f"{' for ' + ONLY if ONLY else ''}")
print("=" * 78)

CAND_CONF = min(idx.conf_threshold, II.ENROLLED_CANDIDATE_CONF)
AGREE = II.DailyItemIndexer.CLASS_AGREE_MATCH_THRESHOLD
LOW = II.LOW_CONF_MATCH_THRESHOLD
SHORT = II.VERIFIED_BOX_THRESHOLD
counts = defaultdict(int)
lost = defaultdict(list)


def inside(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    w, h = max(0, x2 - x1), max(0, y2 - y1)
    return (w * h) / max(1, (a[2] - a[0]) * (a[3] - a[1]))


for p in paths:
    img = cv2.imread(p)
    if img is None:
        continue
    counts["frames read"] += 1
    h, w = img.shape[:2]
    ts = dt.datetime.fromtimestamp(os.path.getmtime(p))
    res = idx._model(img, conf=0.08, iou=0.45, verbose=False)[0]
    raw = [(idx._model.names.get(int(b.cls[0]), ""), float(b.conf[0]),
            [int(v) for v in b.xyxy[0]], int(b.cls[0])) for b in res.boxes]
    screens = [xy for nm, cf, xy, _ in raw
               if nm in ("Laptop", "Monitor/TV") and cf >= 0.5]
    enrolled_classes = {it.get("detector_class") for it in items
                        if it.get("detector_class")}

    for nm, cf, xy, cid in raw:
        it = next((i for i in items if nm == i.get("detector_class")), None)
        if it is None:
            continue
        counts["1. boxed with an enrolled item's class"] += 1
        tag = f"{ts.strftime('%d %H:%M:%S')} {it['name']}"

        if cid not in II.PERSONAL_ITEM_CLASS_IDS:
            counts["2. DROPPED: class not in PERSONAL_ITEM_CLASS_IDS"] += 1
            lost["class not personal"].append(tag)
            continue
        if cf < CAND_CONF:
            counts[f"3. DROPPED: detector conf under {CAND_CONF}"] += 1
            lost["conf floor"].append(f"{tag} conf={cf:.2f}")
            continue
        x1, y1, x2, y2 = xy
        cx, cy, ny2 = ((x1 + x2) / 2) / w, ((y1 + y2) / 2) / h, y2 / h
        gate_ok = 0.10 <= cx <= 0.90 and (cy >= 0.38 or ny2 >= 0.45)
        if not gate_ok:
            if nm in enrolled_classes:
                counts["4. position gate BYPASSED (identified belonging)"] += 1
            else:
                counts["4. DROPPED: position gate"] += 1
                lost["position gate"].append(f"{tag} cy={cy:.2f}")
                continue
        crop = img[max(0, y1):y2, max(0, x1):x2]
        if crop.size == 0 or min(crop.shape[:2]) < 10:
            counts["5. DROPPED: crop too small to embed"] += 1
            continue
        counts["6. embedded by MobileNet"] += 1

        e = norm(back.extract_batch([crop]))[0]
        sim = float((gal[it["name"]] @ e).max())
        strict = LOW if cf < 0.30 else AGREE
        bar = min(strict, SHORT) if (have_verifier
                                     and len(it.get("verify_embeddings") or [])) else strict
        if sim < bar:
            counts[f"7. DROPPED: identity under the shortlisting bar {bar:.2f}"] += 1
            lost["identity"].append(f"{tag} sim={sim:.3f} bar={bar:.2f}")
            continue
        counts["8. shortlisted for verification"] += 1

        swallowed = max((inside(xy, s) for s in screens), default=0.0)
        if swallowed >= 0.80:
            counts["9. DROPPED: inside a laptop or monitor"] += 1
            lost["containment"].append(f"{tag} {swallowed:.0%} inside a screen")
            continue

        if not (have_verifier and len(it.get("verify_embeddings") or [])):
            counts["10. no verifier gallery -- passes unchecked"] += 1
            ok, vs = True, None
        else:
            ok, vs = verifier.agrees(crop, it.get("verify_embeddings"))
        if not ok:
            counts[f"11. DROPPED: verifier refused (bar {verifier.VERIFY_THRESHOLD})"] += 1
            lost["verifier"].append(f"{tag} sim={sim:.3f} verifier={vs:.3f}")
            continue
        counts["12. identity CONFIRMED"] += 1
        if vs is not None and vs < verifier.VERIFY_THRESHOLD + 0.05:
            counts["    (of which within 0.05 of the verifier bar)"] += 1
            lost["verifier knife edge"].append(f"{tag} verifier={vs:.3f}")

print()
for k in sorted(counts, key=lambda s: (s.split('.')[0].rjust(3), s)):
    print(f"  {counts[k]:>5}  {k}")

print()
print("=" * 78)
print("WHERE THE LOSSES ARE")
print("=" * 78)
for why, rows in sorted(lost.items(), key=lambda kv: -len(kv[1])):
    print(f"  {len(rows):>4}  {why}")
    for r in rows[:4]:
        print(f"           {r}")
    if len(rows) > 4:
        print(f"           ... and {len(rows) - 4} more")

print()
print("=" * 78)
print("GATES AFTER IDENTITY  (read from the event log, not re-derived)")
print("=" * 78)
since = dt.datetime.utcnow() - dt.timedelta(hours=HOURS)
rows = list(db.eventlogs.find({"user_id": ObjectId(UID), "event_type": "object",
                               "timestamp": {"$gte": since}}).sort("timestamp", 1))
place = defaultdict(int)
framed = 0
for r in rows:
    for e in (r.get("details") or {}).get("items") or []:
        if not e.get("enrolled_item_id"):
            continue
        if ONLY and (e.get("matched_item") or e.get("name")) != ONLY:
            continue
        place[str(e.get("placement"))] += 1
        if r.get("keyframe_id"):
            framed += 1
print(f"  {len(rows)} object event(s) written")
print(f"  placements: {dict(place)}")
print(f"  {framed} carry a keyframe_id and so appear in Memory Search")
print(f"  ITEM_DEDUP_SECONDS={II.ITEM_DEDUP_SECONDS:.0f}s (placed) / "
      f"{II.ITEM_HELD_DEDUP_SECONDS:.0f}s (in_hand) -- one memory per place, "
      f"not one per frame")
print()
print("  Only 'placed' and 'unknown' mint a keyframe. An in_hand sighting is")
print("  recorded without a picture by design, and is hidden from Memory Search.")
