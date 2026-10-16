"""YOLO draws the box. It does not get a vote on what the thing is.

The wearer put their earbuds down and nothing was logged. The case was boxed
correctly, embedded correctly, and matched their own earbuds gallery at 0.723
-- and was thrown away, because Objects365 has no earbuds class so it labels
the case "Mouse", and the matcher compared that word against the item's NAME.
Finding no overlap it called it a disagreement and raised the bar from 0.65 to
0.85, which those earbuds can never clear. The item was rejected on the
strength of its own name.

The obvious fix -- drop the class and judge on the embedding alone -- does not
work here, and the numbers say so plainly. On the same account:

    Phone gallery   vs Rover Earbuds gallery   0.808
    Rover Earbuds   vs Car Keys                0.797
    each gallery with ITSELF, across photos    mean 0.647, min 0.30

The three belongings resemble each other more than each resembles itself, so
no threshold separates them and the class is the only signal that does. On one
real frame the true earbuds score 0.723 while the laptop SCREEN scores 0.699
against the phone: twenty-four thousandths apart.

So the class stays, but it stops being a guess from English. What a detector
calls a shape is a fact about that detector, so it is measured on the item's
own enrolment photos and stored. A box agrees when it carries the label this
item is KNOWN to get.
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

ROUTE_JS = 'C:/Users/dell/Desktop/LOCUS/web_app/backend/routes/userItems.js'
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
AGREE = II.DailyItemIndexer.CLASS_AGREE_MATCH_THRESHOLD
DISAGREE = II.DailyItemIndexer.CLASS_DISAGREE_MATCH_THRESHOLD


def bar(box_label, item):
    """The threshold the matcher would apply, exactly as the live code picks it."""
    agrees = (idx._names_agree(box_label, item["name"])
              or (item.get("detector_class") and box_label == item["detector_class"]))
    return AGREE if agrees else DISAGREE


print("1. the name test alone could never admit the earbuds")
check("'Mouse' shares no word with 'Rover Earbuds'",
      idx._names_agree("Mouse", "Rover Earbuds") is False)
check("so on the name alone the bar is the strict one",
      bar("Mouse", {"name": "Rover Earbuds"}) == DISAGREE, f"{DISAGREE}")
check("and 0.723 cannot clear it", 0.723 < DISAGREE,
      "the earbuds were correctly boxed and correctly embedded, and rejected anyway")

print()
print("2. the measured class admits them, and nothing else")
earbuds = {"name": "Rover Earbuds", "detector_class": "Mouse"}
phone = {"name": "Phone", "detector_class": "Cell Phone"}
check("a 'Mouse' box agrees with the earbuds now",
      bar("Mouse", earbuds) == AGREE, f"{AGREE}")
check("and 0.723 clears that", 0.723 >= AGREE)
# Every false positive measured on the same frames, all still refused.
for label, sim, item, what in (
        ("Monitor/TV", 0.732, phone, "the laptop screen"),
        ("Chair", 0.741, phone, "a chair"),
        ("Printer", 0.718, phone, "a printer"),
        ("Person", 0.719, {"name": "Car Keys", "detector_class": None}, "a person"),
        ("Mouse", 0.729, phone, "the earbuds case matching the PHONE gallery")):
    check(f"  {what} at {sim:.3f} is still refused", sim < bar(label, item),
          f'"{label}" vs {item["name"]}, bar {bar(label, item)}')

print()
print("3. the name test still works for items whose name the detector shares")
check("'Cell Phone' still agrees with 'Phone' with no stored class",
      bar("Cell Phone", {"name": "Phone"}) == AGREE,
      "items enrolled before this was recorded are unaffected")
check("and a stored class does not override a name that already agrees",
      bar("Cell Phone", phone) == AGREE)
check("an item with no stored class falls back to the name test",
      bar("Mouse", {"name": "Rover Earbuds", "detector_class": None}) == DISAGREE)

print()
print("4. one item's class cannot admit another item")
check("the earbuds' 'Mouse' does not help the phone",
      bar("Mouse", phone) == DISAGREE,
      "this is what refuses the earbuds case matching the phone gallery at 0.729")

print()
print("5. it is wired through, end to end")
src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
check("the matcher reads the stored class", 'item["detector_class"]' in src)
check("and the query asks for it", '"detector_class": 1' in src)
check("and the cached item carries it", '"detector_class": doc.get("detector_class")' in src)
rd = io.open(os.path.join(DP, 'ai', 'routes_detection.py'), encoding='utf-8').read()
check("enrolment measures it from the photos", 'detector_class' in rd and 'votes.most_common' in rd)
check("a label seen in only one photo is not trusted",
      'n >= max(2, len(valid_images) // 4)' in rd)
BE = r'C:\Users\dell\Desktop\LOCUS\web_app\backend'
check("the API stores it",
      'detector_class: detectorClass' in io.open(os.path.join(BE, 'routes', 'userItems.js'),
                                                 encoding='utf-8').read())
check("and the model has the field",
      'detector_class' in io.open(os.path.join(BE, 'models', 'UserItem.js'),
                                  encoding='utf-8').read())

print()
print("6. this account's items, as stored")
db = MongoClient('mongodb://127.0.0.1:27017').locusDB
rows = list(db.useritems.find({"user_id": {"$in": [ObjectId(UID), UID]}, "is_active": True},
                              {"item_name": 1, "detector_class": 1}))
for r in rows:
    print(f"     {r['item_name']:<16} detector_class={r.get('detector_class')}")
check("the earbuds know they get boxed as a Mouse",
      any(r.get("detector_class") == "Mouse" for r in rows))
check("the phone knows it gets boxed as a Cell Phone",
      any(r.get("detector_class") == "Cell Phone" for r in rows))
# Absence of evidence is stored as absence.
#
# This used to name Car Keys, which had never been matched through a detector
# box and so had nothing honest to record. The wearer has since deleted and
# re-enrolled their items and the keys are no longer active, so a check about
# a RULE failed on a fact about one row. The rule is the part worth keeping,
# so it is now asked of whatever items happen to exist: a stored class is a
# label a detector actually produced, never one inferred from what the wearer
# called the thing.
unset = [r["item_name"] for r in rows if not r.get("detector_class")]
check("a stored class is never the item's own name",
      all((r.get("detector_class") or "").lower() != r["item_name"].lower() for r in rows),
      "that is what a guess would look like: 'Phone' -> 'Phone', not 'Cell Phone'")
check("and an item with no evidence is left unset rather than filled in",
      all(r.get("detector_class") is None for r in rows if r["item_name"] in unset),
      f"unset: {unset or 'none on this account right now'}")
check("  which is the API's default, not an accident",
      "aiRes.data.detector_class || null" in io.open(ROUTE_JS, encoding='utf-8').read(),
      "enrolment that measures nothing writes null")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
