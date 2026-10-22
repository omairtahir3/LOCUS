"""A pill pinched between two fingers is a pill being taken.

The 01:30 session of 23 October 2026 refused a dose that was plainly in hand.
Thirty-seven pill detections, the best at 0.79 confidence, two hands in frame,
the hand at the top of the frame and moving upward -- and `in_hand=False` on
every single frame, so Phase 1 never opened and no sequence could exist.

The cause was the fingertip false-positive test:

    if min_tip_dist < 45 and palm_dist > min_tip_dist * 2:

The second clause was meant to read "much nearer the tip than the palm", but
it scales off a quantity that is almost zero. At the distances the log
actually recorded -- tip 1 to 17 px, palm 90 to 134 px -- it asks only that
the palm be more than 2 to 34 px away, which a palm always is. So it was true
on every detection and the rule collapsed to "within 45 px of any fingertip".

That is exactly where a tablet is held. And the veto is absolute, not a
penalty: it multiplies the overlap by 0.1, and an overlap is at most 1.0, so a
flagged detection can never reach the 0.15 bar again by any route.

The corrected test compares the two nearest tips to each other, which needs no
scale at all: a fingertip mistaken for a pill has one tip almost touching it
and the next one far away, while a pill pinched between finger and thumb has
two tips at about the same distance.
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

PASS = FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}" + (f" -> {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f" -> {detail}" if detail else ""))


def hand(cx, cy, w=200, h=250):
    """A hand box centred on (cx, cy)."""
    return {"x1": cx - w / 2, "y1": cy - h / 2, "x2": cx + w / 2, "y2": cy + h / 2}


def pill(cx, cy, size=26):
    """A round detection of pill size, well inside the hand box."""
    return {"confidence": 0.79,
            "bbox": {"x1": cx - size / 2, "y1": cy - size / 2,
                     "x2": cx + size / 2, "y2": cy + size / 2}}


def tips(positions):
    return [{"x": x, "y": y} for x, y in positions]


print("Fingertip rule: a pinch is not a false positive\n")

from ai.pipeline import MedicationDetectionPipeline as P

detector = P.__new__(P)   # geometry only; no models, no stream

HAND_CX, HAND_CY = 640, 300

# Five tips of a hand whose fingers are apart. The thumb and index bracket the
# point (640, 240); the other three are well away from it.
SPREAD = [(628, 240), (652, 240), (700, 250), (740, 262), (776, 278)]

# ── 1. A pill pinched between thumb and index ──────────────────────────────
gesture = {
    "all_hand_bboxes": [hand(HAND_CX, HAND_CY)],
    "all_fingertips": [tips(SPREAD)],
    "all_palm_centers": [{"x": HAND_CX, "y": HAND_CY + 60}],
}
in_hand, overlap, count = detector.is_pill_in_hand([pill(640, 240)], gesture)
check("a pill pinched between thumb and index is in hand",
      in_hand, f"overlap={overlap}, count={count}")
check("and it is counted, so Phase 1 has something to open on",
      count >= 1, f"count={count}")

# ── 2. A fingertip mistaken for a pill ─────────────────────────────────────
# Centred on the pinky tip, with the next tip 38 px away: one tip almost
# touching, the rest far. This must still be refused.
in_hand, overlap, count = detector.is_pill_in_hand([pill(776, 278)], gesture)
check("a detection sitting on one fingertip alone is still refused",
      not in_hand, f"overlap={overlap}, count={count}")

# ── 3. The exact geometry the session logged ───────────────────────────────
# "Near ring tip (tip=9px, palm=92px)". Under the old rule this was vetoed
# because 92 > 18. With the ring and middle tips both near, it is a grasp.
CLOSED = [(560, 250), (596, 243), (632, 240), (668, 241), (704, 248)]
gesture_closed = {
    "all_hand_bboxes": [hand(HAND_CX, HAND_CY)],
    "all_fingertips": [tips(CLOSED)],
    "all_palm_centers": [{"x": HAND_CX, "y": HAND_CY + 32}],
}
in_hand, overlap, count = detector.is_pill_in_hand([pill(650, 241)], gesture_closed)
check("the logged geometry (tip ~9px, palm ~92px) is no longer vetoed",
      in_hand, f"overlap={overlap}, count={count}")

# ── 4. The guards that were never the problem still hold ───────────────────
big = {"confidence": 0.79,
       "bbox": {"x1": 560, "y1": 200, "x2": 720, "y2": 360}}   # 160x160, huge
in_hand, _, _ = detector.is_pill_in_hand([big], gesture)
check("an object too large for a pill is still refused", not in_hand)

faint = {"confidence": 0.30,
         "bbox": {"x1": 628, "y1": 228, "x2": 652, "y2": 252}}
in_hand, _, _ = detector.is_pill_in_hand([faint], gesture)
check("a detection under the confidence floor is still refused", not in_hand)

long_thin = {"confidence": 0.79,
             "bbox": {"x1": 600, "y1": 236, "x2": 700, "y2": 248}}  # aspect 8.3
in_hand, _, _ = detector.is_pill_in_hand([long_thin], gesture)
check("a detection too elongated to be a tablet is still refused", not in_hand)

no_hands = {"all_hand_bboxes": [], "all_fingertips": [], "all_palm_centers": []}
in_hand, _, _ = detector.is_pill_in_hand([pill(640, 240)], no_hands)
check("a pill with no hand in the frame is still not in a hand", not in_hand)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
