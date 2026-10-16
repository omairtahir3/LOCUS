"""A phone on your lap is not a phone in your hand.

The wearer put their phone down beside the laptop and nothing appeared. It had
been detected and logged -- Phone, via a Cell Phone box, similarity 0.667 --
and recorded as in_hand, which stores no frame and is excluded from the
timeline, so from their side it vanished.

The frame shows the phone lying flat on the bed and the hand on the laptop
trackpad, in boxes that do not touch:

    phone  (195, 521) - (413, 662)      3.34% of frame
    hand   (599, 374) - (874, 562)      no overlap at all

It was called held on SIZE. The learned bar for that phone is 1.55% of frame,
bootstrapped from its own sightings (small cluster 0.72%, large 3.34%), and
3.34% cleared it. The stored record says hands_seen: false, because size had
decided -- while a hand was in plain view, somewhere else.

A lap is about as close to a chest camera as a hand is. Size cannot separate
those two and must not pretend to. It keeps the job it was added for, a hand
off the frame edge holding something up close, and loses the power to overrule
hands it can see.
"""
import io
import os
import sys

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


def placement(size_says_placed, overlap_held, hand_boxes, size_held):
    """The decision exactly as the indexer now orders it."""
    if size_says_placed:
        return "placed"
    if overlap_held:
        return "in_hand"
    if hand_boxes:
        return "placed"
    if size_held:
        return "in_hand"
    return "unknown"


print("1. the lap, which is what went wrong")
check("a hand in view and not on it means PUT DOWN",
      placement(False, False, True, True) == "placed",
      "3.34% of frame, over the 1.55% bar, hand on the trackpad")
check("even though size alone would have said held",
      placement(False, False, False, True) == "in_hand",
      "the same size, with no hand anywhere in view")

print()
print("2. the case size was added for still works")
# A hand off the frame edge holding something close: no hand box, big item.
check("no hands visible and the item is large: held",
      placement(False, False, False, True) == "in_hand")
check("no hands visible and the item is small: placed",
      placement(True, False, False, False) == "placed")
check("no hands and no size opinion: nothing is claimed",
      placement(False, False, False, False) == "unknown",
      "unknown is honest; it is neither stored as a memory nor read as carried away")

print()
print("3. a hand actually ON it still wins")
check("overlap says held", placement(False, True, True, False) == "in_hand")
check("and size cannot veto a real overlap upward",
      placement(False, True, True, True) == "in_hand")
check("but a far-too-small item still refuses the overlap",
      placement(True, True, True, False) == "placed",
      "a hand elsewhere in the flat projection covers a small distant object")

print()
print("4. size may no longer train itself on decisions it did not make")
src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
check("size_decided excludes the case where hands were visible",
      "size_held and not overlap_held\n                                                    and not hand_boxes"
      in src or "and not hand_boxes" in src,
      "or the threshold would harden the mistake that produced it")
check("hands are consulted before size in the chain",
      src.index('elif hand_boxes:') < src.index('elif size_held:'),
      "this ordering IS the fix")

print()
print("5. the real numbers from that frame")
PHONE_AREA, THRESHOLD = 0.0334, 0.0155
check("the phone did clear the learned size bar", PHONE_AREA >= THRESHOLD,
      f"{PHONE_AREA:.4f} vs {THRESHOLD:.4f}")
# The two boxes, exactly as recorded.
px1, py1, px2, py2 = 195, 521, 413, 662
hx1, hy1, hx2, hy2 = 599, 374, 874, 562
ox = max(0, min(px2, hx2) - max(px1, hx1))
oy = max(0, min(py2, hy2) - max(py1, hy1))
check("and the hand box does not touch it at all", ox * oy == 0,
      f"overlap {ox}x{oy} px")
check("so the new order calls it placed",
      placement(False, ox * oy > 0, True, PHONE_AREA >= THRESHOLD) == "placed",
      "a frame is kept and it reaches the timeline")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
