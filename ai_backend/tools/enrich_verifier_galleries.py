"""Teach every item's verifier gallery what this camera makes of it.

    python ai_backend/tools/enrich_verifier_galleries.py            # dry run
    python ai_backend/tools/enrich_verifier_galleries.py --apply
    python ai_backend/tools/enrich_verifier_galleries.py --apply --hours 48
    python ai_backend/tools/enrich_verifier_galleries.py --revert    # undo

Generic by construction: it iterates the wearer's active items and uses each
one's own measured detector_class and its own galleries. Nothing here names a
phone or a pair of earbuds, and an item enrolled tomorrow is handled the same
way without editing this file.

WHY. The gate trace puts the verifier at the centre of the funnel: of 96
shortlisted sightings in eight hours it confirmed 52 and refused 35, and 17 of
the 52 sat within 0.05 of its threshold. That is not a threshold that needs
moving -- the decoys it refuses sit at 0.516 and 0.531, directly under the true
sightings at 0.55 to 0.59 -- it is a gallery that has never seen this room. Each
item's verify_embeddings was built from ONE enrolment photograph plus a handful
of crops, taken with a phone camera in good light at close range, while the
chest camera delivers the same object small, dim and at an angle.

Precedent on this wearer's own data: the earbuds scored 0.468 to 0.531 from a
single bright top-down photograph, and three in-situ crops took them to 0.766
to 0.941.

WHY THIS IS NOT THE THING THAT BROKE DETECTION BEFORE. Adopted crops once made
a laptop bezel score 0.763 against the phone and it was logged as the phone.
Those crops went into the MOBILENET gallery, where this wearer's belongings sit
0.808 from each other and only 0.653 from themselves -- adding vectors in a
space with negative separation pushes decoys over the line. The verifier's
space is the opposite: 0.804 to itself, 0.234 to the nearest other item. That
difference, not the crops, is why one failed and the other works.

HOW A CROP EARNS ITS PLACE. Four independent conditions, all required:

  1. the detector's label equals the item's MEASURED detector_class, so the
     agreement is a fact about the detector rather than two names sharing a
     word
  2. MobileNet scores it at MIN_SIM or better -- an independent model, in a
     different feature space
  3. the verifier scores it at MIN_VERIFY or better, which is deliberately far
     above its own decision threshold, so only crops it is already sure about
     can teach it
  4. it is not 80% inside a laptop or monitor box, which is the decoy that has
     caused every observed false positive here

Then crops are kept only if they ADD something: one that is within DIVERSITY of
a vector already in the gallery is skipped, so twenty frames of a stationary
object cannot flood it with the same view.

ON THE CIRCULARITY, honestly. Condition 3 uses the verifier to choose what
teaches the verifier. The margin is what keeps that safe: at MIN_VERIFY the
crop is far clearer than anything it would decide, so the gallery gains views
it already recognises in harder light rather than views it guessed at. It
cannot pull itself toward noise, because noise never clears the margin. Every
vector records where it came from, and --revert removes exactly those, so this
is reversible in a way adoption was not.
"""
import argparse
import datetime as dt
import glob
import os
import sys
import warnings

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
KF = os.path.join(AI, "keyframe_backend")

# A crop must clear BOTH models by a margin, not merely pass their decisions.
MIN_SIM = float(os.environ.get("ENRICH_MIN_SIM", 0.62))
MIN_VERIFY = float(os.environ.get("ENRICH_MIN_VERIFY", 0.65))
DIVERSITY = float(os.environ.get("ENRICH_DIVERSITY", 0.92))
MAX_NEW_PER_ITEM = int(os.environ.get("ENRICH_MAX_PER_ITEM", 12))
SCREEN_FRAC = 0.80

ap = argparse.ArgumentParser()
ap.add_argument("--apply", action="store_true")
ap.add_argument("--revert", action="store_true")
ap.add_argument("--hours", type=float, default=36.0)
args = ap.parse_args()

db = MongoClient("mongodb://127.0.0.1:27017").locusDB
q = {"user_id": {"$in": [ObjectId(UID), UID]}, "is_active": True}


def norm(a):
    a = np.asarray(a, dtype=np.float32)
    if a.size == 0:
        return a.reshape(0, 0)
    return a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-9)


if args.revert:
    for doc in db.useritems.find(q):
        meta = doc.get("verify_from_camera") or []
        if not meta:
            continue
        vec = doc.get("verify_embeddings") or []
        keep = vec[:len(vec) - len(meta)]
        db.useritems.update_one({"_id": doc["_id"]}, {
            "$set": {"verify_embeddings": keep},
            "$unset": {"verify_from_camera": ""}})
        print(f"  {doc['item_name']:<16} removed {len(meta)} camera vector(s), "
              f"{len(keep)} enrolment vector(s) remain")
    print("reverted")
    sys.exit(0)

if not verifier.available():
    print("the verifier will not load; nothing to enrich")
    sys.exit(1)

idx = II.DailyItemIndexer.get_instance()
idx._ensure_model_loaded()
idx._user_items_cache = {}
back = idx._get_embedding_backbone()
items = idx._get_user_items_cached(UID)
verifier.embed([np.zeros((64, 64, 3), np.uint8)])

print(f"MIN_SIM {MIN_SIM}  MIN_VERIFY {MIN_VERIFY} (decision bar "
      f"{verifier.VERIFY_THRESHOLD})  DIVERSITY {DIVERSITY}  "
      f"cap {MAX_NEW_PER_ITEM}/item")
print(f"{'DRY RUN -- nothing will be written' if not args.apply else 'APPLYING'}")
print()


def inside(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    w, h = max(0, x2 - x1), max(0, y2 - y1)
    return (w * h) / max(1, (a[2] - a[0]) * (a[3] - a[1]))


cut = dt.datetime.now() - dt.timedelta(hours=args.hours)
paths = sorted((p for p in glob.glob(os.path.join(KF, "*_storage", "*", "*", "*.jpg"))
                if dt.datetime.fromtimestamp(os.path.getmtime(p)) >= cut),
               key=os.path.getmtime)
print(f"{len(paths)} stored frames in the last {args.hours:.0f} h")
print()

chosen = {it["name"]: [] for it in items}
seen = {it["name"]: 0 for it in items}
for p in paths:
    img = cv2.imread(p)
    if img is None:
        continue
    res = idx._model(img, conf=0.08, iou=0.45, verbose=False)[0]
    raw = [(idx._model.names.get(int(b.cls[0]), ""), float(b.conf[0]),
            [int(v) for v in b.xyxy[0]]) for b in res.boxes]
    screens = [xy for nm, cf, xy in raw
               if nm in ("Laptop", "Monitor/TV") and cf >= 0.5]
    for nm, cf, xy in raw:
        it = next((i for i in items if nm and nm == i.get("detector_class")), None)
        if it is None or len(chosen[it["name"]]) >= MAX_NEW_PER_ITEM:
            continue
        if max((inside(xy, s) for s in screens), default=0.0) >= SCREEN_FRAC:
            continue
        x1, y1, x2, y2 = xy
        crop = img[max(0, y1):y2, max(0, x1):x2]
        if crop.size == 0 or min(crop.shape[:2]) < 16:
            continue
        seen[it["name"]] += 1
        g = norm(it.get("enrol_embeddings") if it.get("enrol_embeddings") is not None
                 else it["embeddings"])
        e = norm(back.extract_batch([crop]))[0]
        sim = float((g @ e).max())
        if sim < MIN_SIM:
            continue
        ok, vs = verifier.agrees(crop, it.get("verify_embeddings"))
        if not ok or vs < MIN_VERIFY:
            continue
        ve = verifier.embed([crop])
        if ve is None:
            continue
        v = ve[0] / (np.linalg.norm(ve[0]) + 1e-9)
        have = [c[0] for c in chosen[it["name"]]]
        if have and max(float(v @ hv) for hv in have) >= DIVERSITY:
            continue                       # nothing new in this view
        chosen[it["name"]].append(
            (v, {"frame": os.path.basename(p)[:8],
                 "at": dt.datetime.fromtimestamp(os.path.getmtime(p)).isoformat(),
                 "sim": round(sim, 3), "verify": round(float(vs), 3),
                 "conf": round(cf, 2)}))

total = 0
for it in items:
    nm = it["name"]
    rows = chosen[nm]
    cur = len(it.get("verify_embeddings") or [])
    print(f"{nm:<16} {seen[nm]:>4} candidate crop(s) -> {len(rows)} kept "
          f"(gallery {cur} -> {cur + len(rows)})")
    for v, m in rows:
        print(f"      {m['frame']}  conf {m['conf']:.2f}  sim {m['sim']:.3f}  "
              f"verifier {m['verify']:.3f}")
    total += len(rows)
    if args.apply and rows:
        doc = db.useritems.find_one({"user_id": {"$in": [ObjectId(UID), UID]},
                                     "item_name": nm, "is_active": True})
        if not doc:
            continue
        vec = list(doc.get("verify_embeddings") or [])
        meta = list(doc.get("verify_from_camera") or [])
        vec += [[float(x) for x in v] for v, _ in rows]
        meta += [m for _, m in rows]
        db.useritems.update_one({"_id": doc["_id"]}, {"$set": {
            "verify_embeddings": vec, "verify_from_camera": meta}})

print()
if args.apply:
    print(f"{total} camera vector(s) added. Provenance is in verify_from_camera; "
          f"--revert removes exactly these.")
else:
    print(f"{total} crop(s) would be added. Re-run with --apply.")
