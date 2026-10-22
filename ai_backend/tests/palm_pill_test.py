"""The tablet the model cannot see.

On 23 October 2026 the pipeline stored its own evidence for three refused
doses. The 02:58 frames show a white tablet plainly in the palm. Run
best_model.onnx over them and it reports nothing there -- not at full
resolution, not on a crop of the hand, not on that crop upscaled three times.
What it returns instead, at 0.39 confidence, is the toes of a teddy bear on
the bed 180 px away:

    5c81c609   pill box (896,496)-(945,527)    hand box (348,416)-(709,720)

That is not a threshold. The model was trained on pills photographed close up
against plain backgrounds, and a 45-pixel disc on skin under one lamp is not
that. Every gate downstream was starved of a true candidate.

find_pills_in_palm searches the OTHER way round: inside the hand box MediaPipe
has already drawn, for something bright, barely saturated, roughly circular
and pill sized. Searching the palm rather than the frame is what makes so
blunt a rule safe -- the teddy bear, the mouse and the phone are outside it by
construction.

This suite pins the two frames where the tablet is visible, and the restraint
that keeps it honest on the frames where it is not.
"""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

AI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import cv2
import numpy as np

PASS = FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}" + (f" -> {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f" -> {detail}" if detail else ""))


print("A pill in the palm, found by shape\n")

from ai.detector import find_pills_in_palm, PALM_PILL_CONFIDENCE

MED = os.path.join(AI, 'keyframe_backend', 'medications_storage',
                   '6a6e439595ff22c2e2f91416', '2026-10-23')

# ── 1. synthetic, so this suite still means something after the frames expire
hand = {"x1": 300, "y1": 380, "x2": 720, "y2": 700}
skin = np.full((720, 1280, 3), 20, dtype=np.uint8)
cv2.rectangle(skin, (300, 380), (720, 700), (110, 130, 170), -1)   # a palm
with_pill = skin.copy()
cv2.circle(with_pill, (520, 560), 21, (245, 246, 248), -1)          # a tablet

hits = find_pills_in_palm(with_pill, [hand])
check("a pale round tablet on a palm is found", len(hits) >= 1,
      f"{len(hits)} candidate(s)")
if hits:
    c = hits[0]["center"]
    check("and it is found where it actually is",
          abs(c["x"] - 520) <= 25 and abs(c["y"] - 560) <= 25,
          f"reported ({c['x']}, {c['y']}) against (520, 560)")
    check("it is offered for confirmation, never as a verified dose on its own",
          hits[0]["confidence"] < 0.85,
          f"confidence {hits[0]['confidence']} — shape is evidence, not identity")
    check("and it says which detector found it",
          hits[0].get("source") == "palm_shape")

check("a bare palm yields nothing", len(find_pills_in_palm(skin, [hand])) == 0)
check("no hand box, no search", len(find_pills_in_palm(with_pill, [])) == 0)

# The teddy bear case: the same tablet OUTSIDE the hand must not be found.
elsewhere = skin.copy()
cv2.circle(elsewhere, (950, 520), 21, (245, 246, 248), -1)
check("a pale round thing outside the hand is ignored",
      len(find_pills_in_palm(elsewhere, [hand])) == 0,
      "this is what kept finding the teddy bear")

# A long pale object in the palm is not a tablet.
oblong = skin.copy()
cv2.rectangle(oblong, (440, 550), (620, 575), (245, 246, 248), -1)
check("a pale oblong in the palm is rejected on shape",
      len(find_pills_in_palm(oblong, [hand])) == 0)

# Something far too large to swallow.
big = skin.copy()
cv2.circle(big, (520, 560), 95, (245, 246, 248), -1)
check("something too large for a tablet is rejected",
      len(find_pills_in_palm(big, [hand])) == 0)

# ── 2. the real frames, while they are still within retention ─────────────
REAL = {
    "5c81c609-3678-4151-b9d1-b9717041e0cc": (540, 596),
    "86afcc87-8252-4602-9d83-70a0bdecc7a3": (550, 531),
}
if not os.path.isdir(MED):
    print("\n  SKIP  the 02:58 evidence has expired (36 h retention)")
else:
    from ai.gesture import GestureDetector
    ges = GestureDetector()
    found_any = False
    for fid, (ex, ey) in REAL.items():
        p = os.path.join(MED, fid + ".jpg")
        if not os.path.exists(p):
            continue
        found_any = True
        img = cv2.imread(p)
        g = ges.analyze_frame(img)
        hits = find_pills_in_palm(img, g.get("all_hand_bboxes") or [])
        near = [h for h in hits
                if abs(h["center"]["x"] - ex) <= 30 and abs(h["center"]["y"] - ey) <= 30]
        check(f"{fid[:8]}: the tablet the model missed is found",
              len(near) >= 1,
              f"expected near ({ex}, {ey}), got "
              f"{[(h['center']['x'], h['center']['y']) for h in hits] or 'nothing'}")
    if not found_any:
        print("  SKIP  the named frames have expired")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
