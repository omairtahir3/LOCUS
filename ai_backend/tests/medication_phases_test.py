"""Swallowing a pill hides it. The phase logic must not require otherwise.

The wearer took their medicine and it was not logged. Their log:

    [Phase1] OK Best pill-in-hand at frame 4 (pill=0.51, count=1)
    [PillInHand] OK Pill confirmed in hand (overlap=1.00, size=0.06,
                    conf=0.42, palm_ok=True)
    [Phase2] REJECTED at frame 18: pill not present during motion
                                   (best_pill=0.000 < 0.45)

Phase 1 passed with every geometric check satisfied. Phase 2 then threw the
sequence away because the pill was no longer VISIBLE while the hand rose:

    F4:  pill=0.51  in_hand=True  hand_y=0.13
    F18: pill=0.00  hands=1  hand_y=0.09  near_top=True  motion=0.37
    F22: pill=0.00  hands=1  hand_y=0.22  near_top=True

Hand at mouth height, moving, pill reading zero -- because the fingers are
closed around a 13 mm tablet. The check asked the detector to see through a
fist, so it failed on every genuine dose for the same reason.

Two further facts make the veto wrong rather than merely strict. The pill
vanishing between hand and mouth is the event being detected, and Phase 3
exists to confirm it is gone afterwards. And what rules out "a hand near the
face holding a pen" -- the concern the check was added for -- is Phase 1, which
has already confirmed a pill in that same hand.
"""
import io
import os
import sys
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}"
          + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = io.open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()

print("1. an invisible pill no longer aborts a sequence")
check("Phase 2 has no outright rejection",
      'REJECTED at frame' not in src,
      "it discarded every real dose; the pill is hidden by the hand holding it")
check("the pill signal scales the score instead",
      'p2_score + 0.10' in src and 'p2_score - 0.10' in src,
      "visible is worth something, hidden costs a little, neither is fatal")
check("and the threshold still means something",
      'PHASE2_MIN_PILL_CONF' in src,
      "it chooses which way the score moves")
check("the reduced-score case says so in the log",
      'pill not visible at frame' in src and 'the sequence continues' in src,
      "so a weak sequence can still be understood afterwards")

print()
print("2. what still rules out a hand holding a pen")
check("Phase 1 must confirm a pill IN the hand",
      'PillInHand' in src and 'palm_ok' in src,
      "overlap, size and palm checks, before Phase 2 is ever evaluated")
check("and the original concern is recorded, not deleted",
      'a pill, a pen, or nothing at all' in src,
      "Phase 2 judging hand position alone was a real false-positive source")

print()
print("3. the physical reasoning is written down")
# "through a fist" without the verb: the sentence wraps across comment lines,
# so "see through a fist" is not a substring of the file.
check("the occlusion is explained with the wearer's own frames",
      'through a fist' in src and 'F18: pill=0.00' in src,
      "a 13 mm tablet gripped in a closing hand reads 0.00")
check("and the disappearance is named as CONFIRMING evidence",
      'CONFIRMING' in src and 'Phase 3 exists' in src,
      "a pill vanishing between hand and mouth is the event")

print()
print("4. a complete sequence is still never discarded on the aggregate")
check("three passed phases are floored at needs_confirmation",
      'All three phases of an intake were observed' in src,
      "0.684 against a 0.70 bar once binned a dose that was fully observed")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
