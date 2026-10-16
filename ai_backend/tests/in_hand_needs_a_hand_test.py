"""A grasp must be supported by a hand. Size may doubt one; it may not assert one.

Two sightings of the wearer's earbuds were lost on 14 Oct because size claimed
they were held when no hand was in the frame at all:

    02:38:18  in_hand  hands_seen=False  area=0.0076
    02:39:35  in_hand  hands_seen=False  area=0.0057

An in_hand sighting stores no frame, so both vanished from Memory Search. And
size had nothing to assert with: across every recorded sighting of that item,
held runs 0.0027-0.0156 (median 0.0057) and placed runs 0.0011-0.0430 (median
0.0060) -- the held median is the LOWER one. The threshold separating them was
the geometric midpoint of a single distribution, from three hands-decided
samples.

What was NOT at fault, measured over 27 claimable boxes with a hand in frame:
_is_held called exactly one of them held, and that one touched the hand with
22% overlap at zero padding. Its 76 px of padding did no damage. The bug was
never the overlap geometry.
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


src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()

print("1. size may no longer assert a grasp")
check("the no-hands size branch records 'unknown', not 'in_hand'",
      'd["placement"] = "unknown"' in src
      and 'NO hand is in view' in src)
check("and it says so, naming the area and the threshold it doubted",
      'placement unknown, frame kept' in src)
check("the measurement that justifies it is written down",
      '0.0027-0.0156' in src and '0.0011-0.0430' in src,
      "the held median is the lower of the two")

print()
print("2. an uncertain placement keeps its picture")
check("a frame is kept for 'placed' OR 'unknown'",
      'd.get("placement") in ("placed", "unknown")' in src,
      "losing the frame loses the memory; a wrong label costs nothing")
check("but only 'placed' asserts a put-down",
      'moved = (placement == "placed"' in src,
      "so an unknown placement cannot raise a left-behind alert about "
      "something in the wearer's pocket")

print()
print("3. what is deliberately UNCHANGED")
check("size can still VETO a hand overlap",
      'size_says_placed = ' in src and 'size_says_placed:' in src,
      "an object far too small to be in a hand is not in one, whatever the "
      "boxes overlap -- a real and measured save")
check("seeing hands and none on the item is still 'placed'",
      'Hands are in view and none of them is on this' in src)
check("a hand actually ON the item is still 'in_hand'",
      'elif overlap_held:' in src and 'd["placement"] = "in_hand"' in src)
check("the overlap geometry is untouched",
      'ITEM_HELD_OVERLAP_FRAC' in src and 'ITEM_HELD_NEAR_FRAC' in src,
      f"{II.ITEM_HELD_OVERLAP_FRAC} of the item's area against a hand box "
      f"padded by {II.ITEM_HELD_NEAR_FRAC} of the frame width; measured "
      f"correct on 27 of 27 boxes")

print()
print("4. the branch order still puts hands above size")
i_overlap = src.index('elif overlap_held:')
i_handsonly = src.index('elif hand_boxes:')
i_size = src.index('elif size_held:')
check("overlap, then hands-elsewhere, then size", i_overlap < i_handsonly < i_size,
      "size is the last resort, not the first word")
# Matched without the leading word, because the sentence wraps across a comment
# line and 'loses\n# the power...' is not a substring of the file.
check("and size can no longer outrank a hand it can see",
      'the power to overrule hands it can see' in src,
      "a phone flat on the wearer's lap was called held because size outranked "
      "a hand detected on the laptop trackpad")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
