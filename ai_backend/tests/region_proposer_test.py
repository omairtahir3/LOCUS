"""The frame proposes candidates; the grid only ever laid squares over it.

A belonging that YOLO cannot box falls to the tile scanner, which slides fixed
120px and 199px windows every 90px and 149px from a fixed origin. Whether a
window lands squarely on anything is arithmetic luck. On a frame where the
wearer's phone sat in plain view, well lit:

    a crop placed ON it     phone fills 100% of the window   0.788
    grid window 1           phone fills  38%                 0.514
    grid window 2           phone fills  25%                 0.588
    grid window 3           phone fills  32%                 0.479
    grid window 4           phone fills  22%                 0.545

The classifier was never the problem. An embedding averages everything in the
window, so a window that is three quarters bedspread embeds as bedspread.

Two changes, neither of which knows what a phone looks like.

FIRST, the frame proposes its own candidates: MSER regions, over the image and
its inverse so dark-on-light and light-on-dark both count, plus contours of
Canny edges for objects whose interior is too textured to be one stable
region. Padded by PROPOSE_MARGIN to match the margin the GALLERY was built
with -- enrolment crops carry ENROLL_CROP_MARGIN, so a proposal trimmed to the
bare contour is tighter than anything it is compared against. Measured on the
same phone: 0.723 bare, 0.809 padded.

SECOND, and this is what makes the first safe: fitted boxes flatter the wrong
things too. The corner of the wearer's laptop screen scored 0.695 as a grid
window and 0.772 once a proposal cropped it cleanly. No score separates it --
its runner-up gap (0.231) is as healthy as the real phone's (0.264) -- and
frame-level corroboration passes both, because hands are in shot. Raising the
bar to 0.78 would have worked on exactly one true positive and one decoy,
0.037 apart, which is the kind of fitted threshold this project has been burnt
by before.

What separates them is what CONTAINS them. The phone sat inside a Desk; the
impostor sat inside a Laptop. A belonging rests ON a desk, a bed or a sofa; it
is never INSIDE a laptop, a television or a person. That is a fact about the
world rather than a number tuned to this frame.

Measured end to end, through the real scanner, on four frames whose truth was
confirmed with the wearer:

    grid alone        phone found 0/4,  0 false positives
    proposer + rule   phone found 1/4,  0 false positives

Still 3 misses: two frames where the phone is dark and face-down on patterned
fabric, which no amount of searching fixes, and one where it reaches 0.641.
The honest gain is one real sighting and no new mistakes.
"""
import glob
import io
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import cv2
import numpy as np

import ai.item_indexer as II
from ai import verifier

UID = '6a6e439595ff22c2e2f91416'
PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
idx = II.DailyItemIndexer.__new__(II.DailyItemIndexer)

print("1. the proposer knows nothing about any particular belonging")
check("it is on", II.PROPOSE_REGIONS is True)
check("and can be switched off", 'os.environ.get("PROPOSE_REGIONS", "1")' in src)
check("MSER runs over the image AND its inverse",
      "cv2.bitwise_not(gray)" in src,
      "or only dark-on-light objects would ever be proposed")
check("contours cover what MSER cannot hold as one region", "cv2.Canny(" in src)
# The CODE, not the prose. The docstring says "nothing here knows what a phone
# looks like", which is the claim being tested rather than a violation of it.
body = src[src.index("def _propose_regions"):src.index("def _swallowed_by_other_object")]
_parts = body.split('"""')          # drop the docstring, keep code either side
code = "\n".join([_parts[0]] + _parts[2:])
code = "\n".join(l for l in code.split("\n")
                 if l.strip() and not l.strip().startswith("#"))
for word in ("phone", "earbud", "bedspread", "laptop"):
    check(f"  no executable line mentions {word!r}", word not in code.lower(),
          "generic by construction; the next belonging may be pale or shiny")

print()
print("2. a proposal is padded to match the gallery it is compared against")
check("the margin equals the enrolment margin",
      abs(II.PROPOSE_MARGIN - II.ENROLL_CROP_MARGIN) < 1e-9,
      f"{II.PROPOSE_MARGIN} vs ENROLL_CROP_MARGIN {II.ENROLL_CROP_MARGIN}")
check("which is a reason, not a tuned number", "0.723 bare, 0.809 padded" in src)
check("the count is bounded", 0 < II.PROPOSE_MAX <= 80, f"{II.PROPOSE_MAX}")
check("and so is the size, both ways",
      0 < II.PROPOSE_MIN_AREA_FRAC < II.PROPOSE_MAX_AREA_FRAC < 0.2)

print()
print("3. a belonging rests ON things, never INSIDE another device")
check("surfaces are named", {"Desk", "Bed", "Couch"} <= II.SURFACE_CLASSES)
check("and devices are deliberately absent from that list",
      not ({"Laptop", "Monitor/TV", "Person"} & II.SURFACE_CLASSES))
check("the rule is applied before a match is kept",
      "inside = self._swallowed_by_other_object(region, boxed, item)" in src
      and src.index("_swallowed_by_other_object(region") < src.index('best[item["id"]] = (sim, region, item)'))
check("an item's OWN detector class never swallows it",
      'name == (item or {}).get("detector_class")' in src,
      "a phone inside the box YOLO drew around that phone is the phone")


def box(x, y, w, h):
    return (x, y, x + w, y + h)


def det(name, conf, x, y, w, h):
    return {"generic_name": name, "confidence": conf,
            "bbox": {"x1": x, "y1": y, "x2": x + w, "y2": y + h}}


phone_item = {"name": "Phone", "detector_class": "Cell Phone"}
check("a candidate inside a Laptop is refused",
      idx._swallowed_by_other_object(box(964, 162, 120, 120),
                                     [det("Laptop", 0.97, 300, 100, 900, 500)],
                                     phone_item) == "Laptop")
check("the same candidate inside a Desk is kept",
      idx._swallowed_by_other_object(box(964, 162, 120, 120),
                                     [det("Desk", 0.51, 300, 100, 900, 500)],
                                     phone_item) is None,
      "a desk is a surface; things sit on it")
check("a container the detector is unsure about does not refuse anything",
      idx._swallowed_by_other_object(box(964, 162, 120, 120),
                                     [det("Laptop", 0.40, 300, 100, 900, 500)],
                                     phone_item) is None,
      f"needs {II.SWALLOWED_CONF} confidence")
check("a candidate merely OVERLAPPING a laptop is kept",
      idx._swallowed_by_other_object(box(100, 100, 200, 200),
                                     [det("Laptop", 0.97, 250, 250, 400, 400)],
                                     phone_item) is None,
      f"it must be {II.SWALLOWED_FRAC:.0%} swallowed, not merely touching")
check("and nothing is refused when the detector boxed nothing",
      idx._swallowed_by_other_object(box(10, 10, 50, 50), [], phone_item) is None)

print()
print("4. end to end, through the real scanner")
TRUTH = {'e159033b': ('keyframe_storage', (736, 482, 100, 100), 'bright, by the laptop'),
         '96993205': ('items_storage', None, 'the laptop-corner decoy')}
have = {k: glob.glob(os.path.join(AI, 'keyframe_backend', v[0], '*', '*', k + '*.jpg'))
        for k, v in TRUTH.items()}
if not all(have.values()):
    print("     SKIPPED: these frames have passed their 36h retention.")
    print("     The recorded figures stand; they cannot be re-derived from frames")
    print("     that no longer exist.")
else:
    real = II.DailyItemIndexer.get_instance()
    real._ensure_model_loaded()
    real._user_items_cache = {}
    # Load the verifier BEFORE timing anything.
    #
    # DINOv2 is 88 MB and loads lazily, on the first candidate that survives
    # far enough to be worth checking. In a fresh process that happens inside
    # the first scan, and this test duly measured 15.1 s where a warm scan
    # takes 6.2 to 6.7 s -- so nine of those seconds were a one-off model load
    # being reported as the per-frame cost. The server pays that load once at
    # startup; charging it to a frame measures the wrong thing. One throwaway
    # embed as well, because the first inference carries torch's own lazy
    # setup and that is not a per-frame cost either.
    if verifier.available():
        verifier.embed([np.zeros((64, 64, 3), np.uint8)])
    for fid, (store, truth, desc) in TRUTH.items():
        img = cv2.imread(have[fid][0])
        dets = []
        for b in real._model(img, conf=0.25, iou=0.45, verbose=False)[0].boxes:
            x1, y1, x2, y2 = [int(v) for v in b.xyxy[0]]
            n = real._model.names.get(int(b.cls[0]), "")
            dets.append({"name": n, "generic_name": n, "confidence": float(b.conf[0]),
                         "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}})
        t0 = time.perf_counter()
        tiles = real._scan_tiles_for_enrolled_items(img, UID, exclude_item_ids=set(), boxed=dets)
        el = (time.perf_counter() - t0) * 1000
        if truth:
            hit = [t for t in tiles if t["name"] == "Phone"]
            on = False
            if hit:
                b = hit[0]["bbox"]
                cx, cy = (b["x1"] + b["x2"]) / 2, (b["y1"] + b["y2"]) / 2
                on = (truth[0] <= cx <= truth[0] + truth[2]
                      and truth[1] <= cy <= truth[1] + truth[3])
            check(f"  {desc}: the phone is found, ON the phone", bool(hit) and on,
                  f"{hit[0]['exemplar_similarity'] if hit else 'nothing'} "
                  f"at {hit[0]['bbox']['x1'] if hit else '-'},{hit[0]['bbox']['y1'] if hit else '-'}")
        else:
            check(f"  {desc}: nothing is claimed", not tiles,
                  f"{len(tiles)} match(es); the grid+adoption version logged the laptop at 0.781")
        # 9 s, above the worst case a scan can actually reach.
        #
        # This bound was 6 s, written when a scan was MobileNet alone. The
        # verifier is now part of a scan and it is deliberately expensive --
        # about 1.2 s a crop -- because that is what buys the separation
        # MobileNet could not: 0.308 between a phone and a television against
        # 0.060. So the cost went up for a reason and the bound follows the
        # cost, rather than the cost being trimmed to fit an old bound.
        #
        # Measured warm, three runs each:
        #
        #     frame                        verifications   scan
        #     the phone by the laptop            1         3.2 - 3.9 s
        #     the laptop-corner decoy            0         1.6 - 1.7 s
        #     the phone frame, full budget       3         6.2 - 6.7 s
        #
        # The last row is the one the ceiling has to cover: it is what a frame
        # costs when every belonging has a candidate worth checking, and it is
        # where VERIFY_MAX_PER_FRAME stops it. The frames below it are cheaper
        # only because there was less to be unsure about.
        #
        # It is still a ceiling worth keeping. A scan is bounded by the region
        # proposer and the verification budget, not by the size of the frame,
        # and if either ceiling is ever removed this is the line that notices.
        # 25 s: a ceiling, not a performance target.
        #
        # The same frame and the same code measured 3.5 s alone, 9.1 s with the
        # live backend running, and 17.0 s inside a full regression run. A 9 s
        # bound sat inside that spread, so the result depended on what else was
        # running rather than on the code -- the third knife-edge timing
        # assertion of mine this codebase has had to have corrected.
        #
        # The question this asks is whether the scan's cost is still BOUNDED:
        # the proposer's output plus a fixed grid, with at most
        # VERIFY_MAX_PER_FRAME verifications. Nothing there scales with frame
        # size or clutter. Losing either ceiling does not cost a factor of two,
        # it costs unbounded growth -- verifying 140 candidates instead of 3 is
        # three minutes. 25 s clears the worst contention seen and still catches
        # that by an order of magnitude.
        check(f"    and the scan's cost is still bounded", el < 25000, f"{el:.0f}ms")

print()
print("5. the grid is still there")
check("proposals are ADDED to it, not swapped for it",
      "candidates = self._propose_regions(image) + candidates" in src,
      "the grid has 20 real sightings to its name; this does not throw them away")
check("and the whole scan still answers to enrolment vectors only",
      'gallery = item.get("enrol_embeddings") or item["embeddings"]' in src)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
