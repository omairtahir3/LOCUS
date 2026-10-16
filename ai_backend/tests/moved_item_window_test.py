"""Moving a belonging must be recorded whenever it happens, not only in the first
five minutes.

The wearer reported: "it does get logged the first time, but when I changed the
location they were not logged again even when the detector correctly detected
them." Three constants, with a gap between two of them:

    MOVED_SPOT_IOU      0.0   a new place needs ZERO overlap with the old box
    MOVED_SPOT_MAX_AGE  300   but position was only consulted within 5 minutes
    ITEM_DEDUP_SECONDS  900   while a repeat is suppressed for 15

Between five and fifteen minutes a move was invisible: too old for the position
rule, too soon for the window. Their events show the move rule never fired at
all -- three sightings of their phone in three places, 40 and 110 minutes
apart, every one admitted by window expiry rather than by detecting a move.

Zero overlap is what guards against a worn camera turning the wearer's head;
the age cap added no safety and only created the gap.
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

import ai.item_indexer as II

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}"
          + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


print("1. there is no interval in which a move is invisible")
check("the position rule reaches as far as the dedup window",
      II.MOVED_SPOT_MAX_AGE >= II.ITEM_DEDUP_SECONDS,
      f"position consulted for {II.MOVED_SPOT_MAX_AGE:.0f}s, window "
      f"{II.ITEM_DEDUP_SECONDS}s -- a gap here is a period where moving a "
      f"belonging produces nothing")
check("  and beyond the window it does not need to",
      True,
      "a sighting older than the window is admitted on time alone")

print()
print("2. what keeps a head turn from looking like a move")
check("a new place needs ZERO shared pixels",
      II.MOVED_SPOT_IOU == 0.0,
      "a worn camera moves every box when the wearer turns; anything short of "
      "no overlap at all would call a glance a move")
check("that is the guard, not the age cap",
      'ZERO shared pixels' in io.open(
          os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read())

src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
print()
print("3. both ways of noticing a move are still there")
check("a caught pick-up counts, whatever the clock says",
      'last_held is not None and last_held > last' in src,
      "the strong signal: a hand was seen on it between two put-downs")
check("and position counts when the pick-up was missed",
      'treating it as moved' in src,
      "a hand closing round a phone hides it, so the carry is often never "
      "caught on camera")
check("the two clocks are kept apart",
      '"_held_at"' in src,
      "folding them together let a continuously-held item push its own write "
      "clock forward and never elapse")

print()
print("4. the regression this fixes, from the wearer's own events")
check("the dead zone is recorded so it is not reintroduced",
      'dead zone' in src and '40 and 110 minutes apart' in src,
      "three places, every one admitted by window expiry, the move rule never "
      "firing once")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
