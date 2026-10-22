"""“Time in the bedroom for 1 min” with no frame in memory search.

The purge was right. The ORDERING was the bug.

    17:15:08  bedroom session opens
    17:15:44  a frame is captured on the way into the washroom -- and it is the
              frame that recognised the bedroom most clearly, so the tracker
              is holding it as the session's illustration
    17:15:4x  the washroom is classified; the purge destroys that frame
    17:17:32  the session finally closes and is written, pointing at it

The purge redacts rows that carry a destroyed frame, and at 17:15 there was no
row yet: the session had not been written. So the row went out with a
keyframe_id for a file that no longer existed.

Two halves to the fix. The tracker keeps the runners-up, not just the best
frame, and nothing is written until a candidate is confirmed to be on disk.
"""
import glob
import io
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import cv2
import numpy as np

from ai.item_indexer import DailyItemIndexer
from ai.scene import SceneSessionTracker, MIN_SESSION_SECONDS, MIN_SESSION_FRAMES
from bson import ObjectId
from db_config import get_client, get_db_name

# The suite's own user, not the wearer's. These tests create frames and
# purge them; pointed at the real account they deleted whatever the camera
# had just captured and marked the rows "the bathroom is private", which
# read exactly like the washroom rule misfiring. See _test_user.py.
from _test_user import TEST_UID, ensure_test_user
UID = ensure_test_user()
PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


root = os.path.join(AI, 'keyframe_backend', 'keyframe_storage', UID,
                    datetime.now().strftime("%Y-%m-%d"))
img = np.full((120, 160, 3), 90, dtype=np.uint8)
written = []


def put_frame(kid):
    os.makedirs(root, exist_ok=True)
    jpg = os.path.join(root, kid + '.jpg')
    cv2.imwrite(jpg, img)
    with open(os.path.join(root, kid + '.json'), 'w') as f:
        json.dump({"id": kid, "user_id": UID,
                   "timestamp": datetime.now(timezone.utc).isoformat()}, f)
    written.append(kid)
    return jpg


try:
    print("1. the tracker keeps runners-up, not just the best frame")
    t = SceneSessionTracker()
    ts = time.time()
    # Three bedroom frames, the BEST one last, as happened on the way out.
    t.observe('bedroom', {"Bed": 0.80, "Pillow": 0.50}, ts, keyframe_id='kf-weak', score=0.40)
    t.observe('bedroom', {"Bed": 0.82, "Pillow": 0.52}, ts + 14, keyframe_id='kf-mid', score=0.55)
    t.observe('bedroom', {"Bed": 0.90, "Pillow": 0.60}, ts + 28, keyframe_id='kf-best', score=0.80)
    open_rec = t.snapshot() if hasattr(t, 'snapshot') else None
    session = t.observe('kitchen', {"Refrigerator": 0.9}, ts + 40) or \
        t.observe('kitchen', {"Refrigerator": 0.9}, ts + 54)
    check("a session closed", session is not None,
          f"needs {MIN_SESSION_SECONDS:.0f}s and {MIN_SESSION_FRAMES} frames")
    if session:
        check("the best frame is still the headline", session["keyframe_id"] == 'kf-best',
              session["keyframe_id"])
        cands = session.get("keyframe_candidates") or []
        check("and the runners-up came with it", len(cands) >= 2, ", ".join(cands))
        check("best first", cands and cands[0] == 'kf-best', ", ".join(cands))
        check("bounded, so a long session does not carry a list of every frame",
              len(cands) <= SceneSessionTracker._MAX_KF_CANDIDATES,
              f"cap {SceneSessionTracker._MAX_KF_CANDIDATES}")

    print()
    print("2. the frame chosen to be written is one that exists")
    pick = DailyItemIndexer._surviving_frame
    gone = f"GONETEST-{uuid.uuid4().hex[:8]}"
    kept = f"KEPTTEST-{uuid.uuid4().hex[:8]}"
    put_frame(kept)
    check("the best frame is used when it is on disk",
          pick({"keyframe_id": kept, "keyframe_candidates": [kept]}) == kept)
    check("a destroyed best frame falls back to a surviving runner-up",
          pick({"keyframe_id": gone, "keyframe_candidates": [gone, kept]}) == kept,
          "this is the bedroom session's case exactly")
    check("and when nothing survives, no id is written at all",
          pick({"keyframe_id": gone, "keyframe_candidates": [gone]}) is None,
          "a dangling id renders as a broken picture; None renders as no picture")
    check("a session that never had a frame is unaffected",
          pick({"keyframe_id": None, "keyframe_candidates": []}) is None)
    check("the headline is preferred over a runner-up that also survives",
          pick({"keyframe_id": kept, "keyframe_candidates": ["x", kept]}) == kept)

    print()
    print("3. both write paths go through the check")
    src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
    check("neither call site passes the raw best frame any more",
          'session, user_id_str, session.get("keyframe_id")' not in src
          and 'session, uid, session.get("keyframe_id")' not in src)
    check("and both ask for a surviving one",
          src.count("self._surviving_frame(session)") == 2)

    print()
    print("4. the row already in the database")
    db = get_client()[get_db_name()]
    ids = [ObjectId(UID), UID]
    rows = list(db.eventlogs.find(
        {"user_id": {"$in": ids}, "details.action": "scene_session",
         "keyframe_id": {"$nin": [None, ""]}}))
    dangling = []
    for r in rows:
        kid = r["keyframe_id"]
        found = glob.glob(os.path.join(
            AI, 'keyframe_backend', '*_storage', '*', '*', f"{kid}.jpg"))
        if not found:
            dangling.append(r)
    # TWO causes, one symptom, and only one of them is a defect.
    #
    # A frame older than the retention window is simply GONE, as designed, and
    # the row keeps its id: every client already falls back when the image
    # 404s, and that is the established convention for belonging memories
    # ("the record of what happened outlives the photograph"). A frame younger
    # than the window that is missing was DESTROYED, and that row should carry
    # the purge's own marking instead of a dangling pointer.
    #
    # Separating them matters: the first pass of this test unset the id on all
    # 16 dangling rows, 15 of which had merely expired, and truncated ids it
    # could not then put back.
    TTL_HOURS = float(os.environ.get("KEYFRAME_TTL_HOURS", 36))
    now = datetime.now(timezone.utc)

    def age_h(r):
        ts = r["timestamp"]
        ts = ts.replace(tzinfo=ts.tzinfo or timezone.utc)
        return (now - ts).total_seconds() / 3600.0

    expired = [r for r in dangling if age_h(r) > TTL_HOURS]
    destroyed = [r for r in dangling if age_h(r) <= TTL_HOURS]
    print(f"     {len(rows)} room sessions carry a frame id; {len(dangling)} point at nothing")
    print(f"       {len(expired)} aged past the {TTL_HOURS:.0f} h window -- expected, left alone")
    print(f"       {len(destroyed)} missing while still inside it -- destroyed")
    for r in destroyed:
        print(f"         {str(r['timestamp'])[:19]}  {r['details'].get('scene')}  "
              f"{str(r['keyframe_id'])[:8]}  written {str(r.get('createdAt'))[11:19]}")

    check("an expired frame keeps its id, as belonging memories do",
          all(r.get("keyframe_id") for r in expired),
          f"{len(expired)} rows untouched")
    if destroyed:
        db.eventlogs.update_many(
            {"_id": {"$in": [r["_id"] for r in destroyed]}},
            {"$unset": {"keyframe_id": ""},
             "$set": {"privacy_redacted": True,
                      "privacy_reason": "the bathroom is private"}})
    remaining = [r for r in db.eventlogs.find(
        {"user_id": {"$in": ids}, "details.action": "scene_session",
         "keyframe_id": {"$nin": [None, ""]}})
        if age_h(r) <= TTL_HOURS
        and not glob.glob(os.path.join(AI, 'keyframe_backend', '*_storage',
                                       '*', '*', f"{r['keyframe_id']}.jpg"))]
    check("no recent room session points at a frame that was destroyed",
          not remaining, f"{len(destroyed)} marked as the purge marks them")
    check("and every session itself is kept, with or without a picture",
          db.eventlogs.count_documents(
              {"user_id": {"$in": ids}, "details.action": "scene_session"}) >= len(rows),
          "where the wearer was, and for how long, is still a true memory")

finally:
    for kid in written:
        for ext in ('.jpg', '.json'):
            try:
                os.remove(os.path.join(root, kid + ext))
            except OSError:
                pass
    print("\n  (test frames removed)")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
