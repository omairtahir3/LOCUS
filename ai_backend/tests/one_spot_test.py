"""One place, one frame.

A belonging resting in one spot kept several frames of that spot: 01:05:35, :40
and :54 all stored the phone at the identical box (377,518)-(519,600), and
02:28:36 and :37 stored two more a second apart. The window gate could not stop
it: it keys on time.monotonic() inside the worker, which is PROCESSING time,
while frames are queued and may be handled far apart, in a process that has since
been replaced and lost the state with it.

Checked against the real boxes from that session.
"""
import sys, os
DP = r'C:\Users\dell\Desktop\LOCUS\ai_backend\detection_pipeline'
os.chdir(DP); sys.path.insert(0, DP)
sys.path.insert(0, r'C:\Users\dell\Desktop\LOCUS\ai_backend')
import inspect
from datetime import datetime, timezone, timedelta
import ai.item_indexer as II
from ai.item_indexer import (DailyItemIndexer, SAME_SPOT_IOU, SAME_SPOT_DRIFT_IOU,
                             SAME_SPOT_DRIFT_SECONDS, ITEM_DEDUP_SECONDS)

PASS = FAIL = 0
def check(l, c, d=""):
    global PASS, FAIL
    print(f"  {'PASS' if c else '*** FAIL ***'}  {l}" + (f" -> {d}" if d else ""))
    if c: PASS += 1
    else: FAIL += 1

idx = DailyItemIndexer.__new__(DailyItemIndexer)
B = lambda x1, y1, x2, y2: {"x1": x1, "y1": y1, "x2": x2, "y2": y2}

print(f"same spot if overlap >= {SAME_SPOT_IOU}, or >= {SAME_SPOT_DRIFT_IOU} within {SAME_SPOT_DRIFT_SECONDS:.0f}s\n")

def same_spot(a, b, gap_s):
    o = idx._box_iou(a, b)
    return (o >= SAME_SPOT_IOU or (o >= SAME_SPOT_DRIFT_IOU and gap_s <= SAME_SPOT_DRIFT_SECONDS)), o

print("1. every put-down pair from the real session, with its real gap")
pairs = [
    ("resting on the desk, 5s later",      B(377,518,519,600), B(377,518,519,600),    5, True),
    ("resting on the desk, 14s later",     B(377,518,519,600), B(377,518,519,600),   14, True),
    ("resting on the desk, 28s later",     B(377,518,519,600), B(377,518,519,600),   28, True),
    ("two frames 1s apart, camera drift",  B(918,515,1062,666), B(866,516,994,634),   1, True),
    ("desk -> elsewhere, 26 min later",    B(377,518,519,600), B(398,472,559,578), 1593, False),
    ("a genuinely different place",        B(398,472,559,578), B(922,352,1171,464),1831, False),
    ("another different place",            B(922,352,1171,464), B(793,550,928,633), 144, False),
]
for label, a, b, gap, want in pairs:
    got, o = same_spot(a, b, gap)
    check(f"   {label:34s} overlap {o:.3f} gap {gap:>4}s",
          got == want, "same spot" if got else "new place")
print("     overlap alone could not do this: a repeat scored 0.322 and a move 0.338")
print("\n2. the database lookup, with a stub")
# The stub answers find(), because that is what the code asks.
#
# It used to offer find_one() alone, from when this check read the single
# newest row. The code now reads the whole window and sorts it, for a reason
# written down beside the query: frames are not processed in the order they
# were captured, so the newest row is not reliably the relevant one. The stub
# did not follow, so every call fell into the code's own except branch, printed
# "same-spot check skipped" and returned False -- and the suite reported a
# broken deduplicator when what was broken was the stand-in for the database.
#
# A cursor is the part that matters: find() has to return something that takes
# .sort() and .limit() and then iterates, or the shape of the real query is
# not being exercised at all.
class Cursor:
    def __init__(s, rows): s.rows = rows
    def sort(s, *a, **k): return s
    def limit(s, n): return Cursor(s.rows[:n])
    def __iter__(s): return iter(s.rows)
class Coll:
    def __init__(s, doc): s.doc = doc
    def find_one(s, *a, **k): return s.doc
    def find(s, q=None, *a, **k):
        # Honour the time window, because the code delegates it.
        #
        # The window is enforced by the query -- timestamp $gte cutoff -- and
        # the loop afterwards uses age only for the drift allowance. That is
        # the right split: a database is better at "rows newer than this" than
        # a Python loop is. But it means a stub that returns every row it
        # holds, whatever the filter said, asks the code to re-implement a
        # filter it deliberately pushed down, and an old row then looks like a
        # deduplicator that never forgets.
        rows = [s.doc] if s.doc else []
        gte = ((q or {}).get("timestamp") or {}).get("$gte")
        if gte is not None:
            rows = [r for r in rows if r["timestamp"] >= gte]
        return Cursor(rows)
class DB:
    def __init__(s, doc): s.eventlogs = Coll(doc)
    def __getitem__(s, _): return s
def stub(box, age_s):
    II.get_client = lambda: DB({
        "timestamp": datetime.now(timezone.utc) - timedelta(seconds=age_s),
        "details": {"items": [{"enrolled_item_id": "phone", "placement": "placed", "bbox": box}]},
    })
    II.get_db_name = lambda: "locusDB"

UID = "6a6e439595ff22c2e2f91416"
det = lambda box: {"enrolled_item_id": "phone", "bbox": box, "matched_item": "Phone", "name": "Phone"}

stub(B(377,518,519,600), 30)
check("the same spot 30 s later is suppressed", idx._already_have_this_spot(UID, det(B(377,518,519,600))) is True)
stub(B(377,518,519,600), 30)
check("a different place is NOT suppressed", idx._already_have_this_spot(UID, det(B(922,352,1171,464))) is False)

print("\n3. the same shelf tomorrow is a new memory")
stub(B(377,518,519,600), ITEM_DEDUP_SECONDS + 60)
check("beyond the window, the same spot is recorded again",
      idx._already_have_this_spot(UID, det(B(377,518,519,600))) is False,
      f"older than {ITEM_DEDUP_SECONDS:.0f}s")

print("\n4. it never blocks on missing or broken data")
stub(B(377,518,519,600), 30)
check("no enrolled id -> not suppressed", idx._already_have_this_spot(UID, {"bbox": B(1,1,2,2)}) is False)
check("no bbox -> not suppressed", idx._already_have_this_spot(UID, {"enrolled_item_id": "phone"}) is False)
II.get_client = lambda: (_ for _ in ()).throw(RuntimeError("db down"))
check("database unreachable -> not suppressed, the frame is kept",
      idx._already_have_this_spot(UID, det(B(377,518,519,600))) is False)
print("     a duplicate picture is a smaller harm than losing where something was left")

print("\n5. it is wired into the storage decision")
src = inspect.getsource(DailyItemIndexer._process_keyframe_task)
check("placed detections are filtered through it", "_already_have_this_spot" in src)
i = src.index("_already_have_this_spot")
check("and that happens BEFORE a keyframe id is minted", src.index("uuid.uuid4()") > i)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
