"""Shape settles a tie only where shape actually separates the two items.

The first version of this compared the live box against each item's MEDIAN
aspect and picked the nearer. That quietly assumed every belonging has a
stable outline, and they do not. Over 29 real boxes of one wearer's phone the
ratio runs 0.50 to 3.29 -- a phone lying in portrait and the same phone lying
in landscape are one object at four times the aspect. Their earbuds case runs
0.82 to 2.46, and twenty-four of the twenty-nine phone boxes sit INSIDE that
range, so "nearer the median" would have handed five phone sightings to the
earbuds.

The 96% that justified it was measured on the same 26 boxes the threshold was
fitted to. On all 47 it is 87%, which is not good enough to overrule a refusal.

So the rule is now: both items need enough boxes on record, their ranges must
be disjoint, and the live box must fall inside one of them. Where the ranges
overlap -- as this account's phone and earbuds do -- shape carries no
information about which of the two this is, and the answer stays "neither".
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
from bson import ObjectId
from pymongo import MongoClient

UID = '6a6e439595ff22c2e2f91416'
PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


idx = II.DailyItemIndexer.__new__(II.DailyItemIndexer)
GAP = II.ASPECT_RANGE_GAP
MINN = II.MIN_SHAPE_SAMPLES


def shape(lo, hi, n=8):
    return {"lo": lo, "hi": hi, "median": (lo + hi) / 2, "n": n}


def decide(live, s1, s2):
    """The tie-break exactly as the matcher applies it (first=best, second=runner-up)."""
    if not (live and idx._shape_usable(s1) and idx._shape_usable(s2)):
        return None
    if s1["hi"] + GAP < s2["lo"]:
        lower, upper, lo_r, hi_r = "first", "second", s1, s2
    elif s2["hi"] + GAP < s1["lo"]:
        lower, upper, lo_r, hi_r = "second", "first", s2, s1
    else:
        return None
    if lo_r["lo"] <= live <= lo_r["hi"]:
        return lower
    if hi_r["lo"] <= live <= hi_r["hi"]:
        return upper
    return None


print(f"needs {MINN} boxes per item, and ranges {GAP} apart")
print()
print("1. THE CASE THAT CAUGHT THIS: overlapping ranges decide nothing")
phone = shape(0.809, 2.352, 16)      # as measured from this account's sightings
earbuds = shape(1.250, 1.550, 5)
check("the two ranges do overlap",
      not (phone["hi"] + GAP < earbuds["lo"] or earbuds["hi"] + GAP < phone["lo"]),
      f"phone {phone['lo']}-{phone['hi']}, earbuds {earbuds['lo']}-{earbuds['hi']}")
# Every real phone box that the median rule would have given to the earbuds.
for ar in (1.49, 2.04, 2.35, 2.35):
    check(f"  a phone box at {ar} is NOT handed to the earbuds",
          decide(ar, phone, earbuds) is None,
          "the old median rule gave this one away")
for ar in (1.28, 1.43, 1.60, 2.00):
    check(f"  and an earbuds box at {ar} is not handed to the phone",
          decide(ar, phone, earbuds) is None)

print()
print("2. where shape DOES separate, it still decides")
keys = shape(0.90, 1.30, 9)        # something compact
bottle = shape(2.20, 3.40, 9)      # something long
check("those two ranges are disjoint", decide(1.10, keys, bottle) is not None)
check("a compact box picks the compact item", decide(1.10, keys, bottle) == "first")
check("a long box picks the long item", decide(2.80, keys, bottle) == "second")
check("a box between the two ranges decides nothing",
      decide(1.80, keys, bottle) is None,
      "inside neither, so it is evidence for neither")
check("and a box outside both decides nothing", decide(5.0, keys, bottle) is None)

print()
print("3. it refuses without enough evidence")
check(f"fewer than {MINN} boxes is not a shape",
      decide(1.10, shape(0.9, 1.3, MINN - 1), bottle) is None)
check("no shape at all on one side decides nothing",
      decide(1.10, None, bottle) is None)
check("no shape on either side decides nothing", decide(1.10, None, None) is None)
check("a missing box on the live detection decides nothing",
      decide(None, keys, bottle) is None)
check("_shape_usable refuses a bare number from the old format",
      idx._shape_usable(0.974) is False,
      "items written before the range form are ignored, not misread")

print()
print("4. it is still only a tie-break")
src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
amb = src[src.index("if best_match_name and second_name and (best_sim - second_sim)"):]
amb = amb[:amb.index("if best_match_name:")]
check("shape is consulted only inside the ambiguity branch",
      "live_ar" in amb and "_shape_usable" in amb)
check("both candidates had already cleared their own thresholds",
      "if sim >= thresh:" in src,
      "shape re-ranks two accepted matches, it never admits a rejected one")
check("and when it cannot choose, neither is claimed", "so neither is claimed" in amb)

print()
print("5. this account, as stored")
db = MongoClient('mongodb://127.0.0.1:27017').locusDB
rows = list(db.useritems.find({"user_id": {"$in": [ObjectId(UID), UID]}, "is_active": True},
                              {"item_name": 1, "box_aspect": 1}))
for r in rows:
    print(f"     {r['item_name']:<16} {r.get('box_aspect')}")
got = {r["item_name"]: r.get("box_aspect") for r in rows}
check("the phone's range is recorded with its width",
      isinstance(got.get("Phone"), dict) and got["Phone"]["hi"] > got["Phone"]["lo"] + 1.0,
      "a phone's aspect is not a constant, and the record says so")
check("and shape changes nothing for this pair today",
      decide(1.40, got.get("Phone"), got.get("Rover Earbuds")) is None,
      "which is the correct answer, not a failure")
check("Car Keys has no shape and so cannot be chosen by one",
      got.get("Car Keys") in (None, {}),
      "its only sightings came from the tile scanner's fixed squares")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
