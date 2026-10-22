"""One frame may stop the camera. Two are needed to destroy anything.

The wearer carried a table past the bathroom doorway. One frame caught it, and
five minutes of their desk were deleted -- including the only frame of their
earbuds and phone put down together. The frame before the boundary, 17:40:23,
shows them typing at that desk, so what went was desk footage, not bathroom
footage.

Two separate faults produced that. The blast radius is fixed elsewhere (a purge
now reaches back only into the visit that triggered it). This is the other
half: a single frame's classification should not be able to delete anything at
all, because deletion cannot be undone.

The gate still closes on the first sighting -- privacy is immediate. Only the
DESTRUCTION waits, and the probe supplies the second opinion within about four
seconds. The trade is explicit and deliberate: if corroboration never arrives,
the first frame of a genuine visit survives on disk. One frame surviving is a
smaller harm than minutes of unrelated frames being destroyed, and no new frame
is stored either way.
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

import ai.privacy as P
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


db = get_client()[get_db_name()]
users = db.users
oid = ObjectId(UID)
original = (users.find_one({"_id": oid}, {"privacy": 1}) or {}).get("privacy")
root = os.path.join(AI, 'keyframe_backend', 'keyframe_storage', UID,
                    datetime.now().strftime("%Y-%m-%d"))
img = np.full((120, 160, 3), 90, dtype=np.uint8)
made = []


def desk_frame(seconds_ago, tag):
    kid = f"CONFIRMTEST-{tag}-{uuid.uuid4().hex[:6]}"
    os.makedirs(root, exist_ok=True)
    jpg = os.path.join(root, kid + '.jpg')
    cv2.imwrite(jpg, img)
    with open(os.path.join(root, kid + '.json'), 'w') as f:
        json.dump({"id": kid, "user_id": UID,
                   "timestamp": (datetime.now(timezone.utc)
                                 .replace(microsecond=0)).isoformat()}, f)
    # backdate so the sidecar reads as captured `seconds_ago`
    import datetime as _dt
    when = datetime.now(timezone.utc) - _dt.timedelta(seconds=seconds_ago)
    with open(os.path.join(root, kid + '.json'), 'w') as f:
        json.dump({"id": kid, "user_id": UID, "timestamp": when.isoformat()}, f)
    made.append(kid)
    return kid, jpg


def reset():
    for stray in glob.glob(os.path.join(root, 'CONFIRMTEST-*')):
        try:
            os.remove(stray)
        except OSError:
            pass
    made.clear()
    P._dead_until.clear()
    P._sensitive_since.clear()
    P._pending_sensitive.clear()
    users.update_one({"_id": oid}, {"$set": {
        "privacy.mode": "off", "privacy.sensitive_rooms": ["bathroom"],
        "privacy.sensitive_places": [], "privacy.auto_dead_until": None,
        "privacy.auto_dead_reason": None, "privacy.auto_dead_kind": None}})
    P._cache.clear()
    P.settings(UID, force=True)


exists = os.path.exists

try:
    print(f"confirmation needs {P.CONFIRM_FRAMES} frames, within "
          f"{P.CONFIRM_WINDOW_SECONDS:.0f}s, probed every {P.PROBE_SECONDS:.0f}s")

    print()
    print("1. a doorway glimpse: camera stops, NOTHING is deleted")
    reset()
    _, desk = desk_frame(20, "desk")
    r1 = P.enter_sensitive_room(UID, 'bathroom', time.time() - 3)
    check("recording stops at once", P.state(UID)["capture"] is False,
          P.state(UID)["reason"])
    check("but nothing was destroyed", r1["files"] == 0 and r1["confirmed"] is False,
          "deletion cannot be undone; stopping the camera can")
    check("the desk frame is untouched", exists(desk),
          "this is the frame the old behaviour deleted")

    print()
    print("2. ...and the next frame says bedroom, so it really was a glimpse")
    lifted = P.left_sensitive_room(UID, 'bedroom')
    check("recording resumes", lifted is True and P.state(UID)["capture"] is True)
    check("the desk frame survived the whole episode", exists(desk))
    check("and the uncorroborated sighting is forgotten",
          UID not in P._pending_sensitive,
          "or it would count towards the NEXT visit's confirmation")

    print()
    print("3. a real visit: the second frame confirms, and both go")
    reset()
    _, desk2 = desk_frame(120, "desk-before")
    _, bath1 = desk_frame(10, "bath-1")
    _, bath2 = desk_frame(5, "bath-2")
    # Boundaries set clear of the frames' own timestamps. The first attempt put
    # the boundary ON bath1's timestamp, where a few milliseconds of elapsed
    # time decided whether it was inside the visit.
    r1 = P.enter_sensitive_room(UID, 'bathroom', time.time() - 14)
    check("first sighting destroys nothing", r1["files"] == 0)
    check("both bathroom frames still on disk", exists(bath1) and exists(bath2))
    r2 = P.enter_sensitive_room(UID, 'bathroom', time.time() - 6)
    check("the second sighting confirms it", r2["confirmed"] is True)
    check("and now both bathroom frames are destroyed",
          not exists(bath1) and not exists(bath2),
          "the purge reaches back to the FIRST of the two, not the second")
    check("while the desk frame from two minutes earlier survives", exists(desk2))

    print()
    print("4. the confirmation must be the SAME room, and recent")
    reset()
    P.enter_sensitive_room(UID, 'bathroom', time.time() - 4)
    seen_before = P._pending_sensitive[UID]["seen"]
    # A different sensitive room restarts the count rather than completing it.
    users.update_one({"_id": oid}, {"$set": {
        "privacy.sensitive_rooms": ["bathroom", "bedroom"]}})
    P.settings(UID, force=True)
    r = P.enter_sensitive_room(UID, 'bedroom', time.time() - 2)
    check("a different room does not complete the pair",
          r["confirmed"] is False and P._pending_sensitive[UID]["seen"] == 1,
          f"was {seen_before} for bathroom, now 1 for bedroom")

    reset()
    P.enter_sensitive_room(UID, 'bathroom', time.time() - 4)
    with P._lock:
        P._pending_sensitive[UID]["at"] -= (P.CONFIRM_WINDOW_SECONDS + 5)
    r = P.enter_sensitive_room(UID, 'bathroom', time.time() - 2)
    check("a sighting from outside the window does not complete it either",
          r["confirmed"] is False,
          f"older than {P.CONFIRM_WINDOW_SECONDS:.0f}s is a new episode, not a pair")

    print()
    print("5. the wiring")
    src = io.open(os.path.join(DP, 'ai', 'privacy.py'), encoding='utf-8').read()
    i_mark = src.index("mark_dead(key, reason, kind=\"room\")")
    i_pend = src.index("_pending_sensitive[key] = pend")
    i_purge = src.index("out = purge_since(key, reason")
    check("the gate closes before the count is even taken", i_mark < i_pend,
          "privacy is immediate; only deletion waits")
    check("and the purge happens after it", i_pend < i_purge)
    check("every path that lifts the gate forgets the pending sighting",
          src.count("_pending_sensitive.pop(key, None)") >= 2)

finally:
    reset()
    if original is None:
        users.update_one({"_id": oid}, {"$unset": {"privacy": ""}})
    else:
        users.update_one({"_id": oid}, {"$set": {"privacy": original}})
    P._cache.clear()
    print(f"\n  (test frames removed; settings restored to "
          f"mode={(original or {}).get('mode')})")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
