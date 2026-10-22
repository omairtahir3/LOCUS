"""Two faults the wearer found the first time the washroom rule ever fired.

It worked: the bathroom was recognised, capture stopped, frames were blurred.
Then:

  1. IT DELETED THE BEDROOM. The purge took everything stored in the last 120
     seconds, and a flat window cannot tell a washroom frame from the bedroom
     frame captured a minute earlier. Walking into the washroom destroyed the
     memories of the room before it.

  2. IT COULD NOT TELL THEY HAD LEFT. The gate stops capture, so nothing is
     classified, so nothing could notice the wearer was back in the bedroom.
     The only way out was the 90-second timer, spent standing in the bedroom
     unrecorded.

The purge is now bounded by the capture time of the earliest frame OF THE
VISIT, and the pipeline probes a frame every few seconds while dead -- one
classified in memory, written nowhere -- purely to notice the room changed.
"""
import glob
import io
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone

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
img = np.full((240, 320, 3), 120, dtype=np.uint8)
root = os.path.join(AI, 'keyframe_backend', 'keyframe_storage', UID,
                    datetime.now().strftime("%Y-%m-%d"))
made = []


def write_frame(seconds_ago: float, tag: str) -> str:
    """A stored frame exactly as the capture loop writes one."""
    kid = f"EXITTEST-{tag}-{uuid.uuid4().hex[:8]}"
    os.makedirs(root, exist_ok=True)
    jpg = os.path.join(root, kid + '.jpg')
    meta = os.path.join(root, kid + '.json')
    cv2.imwrite(jpg, img)
    when = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    with open(meta, 'w') as f:
        json.dump({"id": kid, "user_id": UID, "file": kid + '.jpg',
                   "timestamp": when.isoformat()}, f)
    made.append((kid, jpg, meta))
    return kid


def set_privacy(**kw):
    users.update_one({"_id": oid}, {"$set": {f"privacy.{k}": v for k, v in kw.items()}})
    P.settings(UID, force=True)


try:
    set_privacy(mode='off', sensitive_rooms=['bathroom'], sensitive_places=[],
                auto_dead_until=None, auto_dead_reason=None, auto_dead_kind=None)
    P._dead_until.clear()
    P._sensitive_since.clear()

    exists = lambda jpg: os.path.exists(jpg)

    def fresh_section():
        """Each section gets an empty directory and no carried-over state.

        The first version of this test wrote every section's frames into one
        folder and read the counts across all of them, which made the results
        unreadable; and it put a frame's timestamp exactly on the purge
        boundary, where a few milliseconds of elapsed time decides the answer.
        Offsets below are spaced well clear of the boundary on purpose.
        """
        for stray in glob.glob(os.path.join(root, 'EXITTEST-*')):
            try:
                os.remove(stray)
            except OSError:
                pass
        made.clear()
        P._dead_until.clear()
        P._sensitive_since.clear()

    def visit(*offsets):
        """A CONFIRMED visit. Destroying anything now needs two sightings that
        agree, which the probe supplies about four seconds apart; a lone frame
        stops the camera and deletes nothing. See purge_confirm_test.py."""
        res = None
        for off in (offsets if len(offsets) > 1 else (offsets[0], offsets[0])):
            res = P.enter_sensitive_room(UID, 'bathroom', time.time() - off)
        return res

    print("1. the bedroom survives the washroom")
    fresh_section()
    # The wearer's real sequence: bedroom frames, then they walk in.
    bed_old = write_frame(120, "bedroom-120s")
    bed_recent = write_frame(80, "bedroom-80s")
    bath_a = write_frame(30, "bathroom-30s")
    bath_b = write_frame(10, "bathroom-10s")
    by = {k: j for k, j, _ in made}
    check("four frames are on disk to begin with", all(exists(j) for j in by.values()))

    # The visit began about 40 s ago; classification has only just caught up.
    res = visit(40)
    check("both bathroom frames are destroyed",
          not exists(by[bath_a]) and not exists(by[bath_b]))
    check("the bedroom frame from 80 s earlier SURVIVES", exists(by[bed_recent]),
          "this is the frame the old 120 s window deleted")
    check("and so does the one from 120 s earlier", exists(by[bed_old]))
    check("the purge reports a boundary rather than a window",
          "since" in res, f"{res['files']} files destroyed")

    print()
    print("2. the earliest frame of a visit sets the boundary")
    fresh_section()
    early = write_frame(60, "visit-60s")
    late = write_frame(10, "visit-10s")
    by = {k: j for k, j, _ in made}
    # Frames classified OUT of capture order, which happens routinely.
    visit(20)
    check("the later frame of the visit goes", not exists(by[late]))
    check("the earlier one stands until something places the visit that early",
          exists(by[early]))
    P.enter_sensitive_room(UID, 'bathroom', time.time() - 70)
    check("and goes once an earlier frame of the visit is classified",
          not exists(by[early]), "the earliest timestamp seen in a visit sticks")

    print()
    print("3. a wild timestamp cannot delete an afternoon")
    fresh_section()
    ancient = write_frame(P.PURGE_MAX_LOOKBACK_SECONDS + 600, "ancient")
    recent = write_frame(20, "recent")
    by = {k: j for k, j, _ in made}
    visit(999999)
    check("a frame older than the cap is untouched", exists(by[ancient]),
          f"cap is {P.PURGE_MAX_LOOKBACK_SECONDS:.0f}s")
    check("while one inside the cap still goes", not exists(by[recent]))

    print()
    print("4. the gate lifts when another room is recognised")
    P._dead_until.clear(); P._sensitive_since.clear()
    visit(5)
    st = P.state(UID)
    check("dead while in the washroom", not st["capture"], st["reason"])
    check("and tagged as a ROOM, which is what may be probed out of",
          st.get("kind") == "room", str(st.get("kind")))

    lifted = P.left_sensitive_room(UID, 'bedroom')
    check("recognising the bedroom lifts it", lifted is True)
    check("capture resumes immediately, not after the timer",
          P.state(UID)["capture"] is True,
          f"timer would have held it for {P.AUTO_DEAD_SECONDS:.0f}s")
    doc = users.find_one({"_id": oid}, {"privacy": 1})["privacy"]
    check("and the lifted state is published for the other process",
          doc.get("auto_dead_until") is None)
    check("the visit boundary is forgotten too",
          UID not in P._sensitive_since,
          "or the next visit would purge back to this one")

    print()
    print("5. what must NOT lift the gate")
    P._dead_until.clear(); P._sensitive_since.clear()
    visit(5)
    check("an unrecognised room does not lift it",
          P.left_sensitive_room(UID, None) is False
          and not P.state(UID)["capture"],
          "an unclassifiable frame inside the washroom would reopen it")
    check("the washroom itself does not lift it",
          not P.state(UID)["capture"])

    # A manual pause is the wearer's decision, not a room.
    P._dead_until.clear(); P._sensitive_since.clear()
    set_privacy(mode='paused')
    st = P.state(UID)
    check("a manual pause is tagged 'mode', not 'room'", st.get("kind") == "mode")
    check("and no room recognition can lift it",
          P.left_sensitive_room(UID, 'bedroom') is False
          and not P.state(UID)["capture"],
          "only the wearer turns their own camera back on")
    set_privacy(mode='off')

    print()
    print("6. the probe is classified and thrown away")
    src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
    obs = src[src.index("def _observe_scene"):]
    obs = obs[:obs.index("\n    def ", 10)]
    check("a probe never reaches the session tracker",
          obs.index('"privacy_probe"') < obs.index("tracker.observe"),
          "its frame is not on disk, so it must not become a session's cover photo")
    task = src[src.index("def _process_keyframe_task"):]
    i_scene = task.index("self._observe_scene(")
    i_probe = task.index('"privacy_probe"', i_scene)
    i_store = task.index("Persist Item Keyframe Evidence")
    check("and returns before anything is stored or recorded",
          i_scene < i_probe < i_store)

    pl = io.open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()
    check("the probe runs only for a room", 'if _priv.get("kind") == "room":' in pl)
    check("on an interval, not every frame", "PROBE_SECONDS" in pl)
    check("and carries the flag that keeps it from being stored",
          '"privacy_probe": True' in pl)
    check("the capture time, not now, bounds the purge",
          "self._captured_epoch(metadata)" in src,
          "classification runs behind capture, so now() places it late")

    print()
    print("7. a visit's boundary is forgotten when the gate TIMES OUT")
    # The fault that destroyed five minutes of the wearer's desk.
    #
    # _sensitive_since was cleared only when a probe recognised another room,
    # never when the 90 s timer simply expired. So:
    #
    #   17:14  a bathroom frame sets the boundary
    #   17:16  the timer runs out, the gate opens, the boundary STAYS
    #   17:17  twenty-four minutes of ordinary recording follow
    #   17:40  a second bathroom frame purges from 17:14, clamped only by the
    #          300 s cap -- which still took 17:35 onwards, including the one
    #          frame showing the earbuds and the phone put down together
    fresh_section()
    # The first visit, with nothing of its own on disk yet.
    visit(240)
    check("the first visit set a boundary", UID in P._sensitive_since)

    # The gate expires the way the timer does, rather than via a probe.
    users.update_one({"_id": oid}, {"$set": {
        "privacy.auto_dead_until": datetime.utcnow() - timedelta(seconds=1)}})
    with P._lock:
        P._dead_until[UID] = (time.monotonic() - 1, "the bathroom is private", "room")
    P._cache.pop(UID, None)

    check("capture resumes when the timer runs out", P.state(UID)["capture"] is True)
    check("and the boundary is forgotten with it",
          UID not in P._sensitive_since,
          "this is what was left behind, and what reached back 24 minutes")

    # Only NOW the ordinary stretch of recording that followed. Its frame is
    # older than the 300 s clamp allows, which is the whole point: a stale
    # boundary would have swept it, a per-visit one cannot.
    desk = write_frame(200, "desk-200s")
    by = {k: j for k, j, _ in made}

    # A second, unrelated visit must only ever reach back to ITSELF.
    res = visit(5)
    check("the desk frame from 200 s earlier SURVIVES the second visit",
          exists(by[desk]),
          "with the stale boundary it was inside the 300 s clamp and went")
    check("and the second purge reaches back seconds, not minutes",
          (time.time() - res["since"]) < 30,
          f"{time.time() - res['since']:.0f}s")

finally:
    for kid, jpg, meta in made:
        for f in (jpg, meta):
            try:
                os.remove(f)
            except OSError:
                pass
    for stray in glob.glob(os.path.join(root, 'EXITTEST-*')):
        try:
            os.remove(stray)
        except OSError:
            pass
    if original is None:
        users.update_one({"_id": oid}, {"$unset": {"privacy": ""}})
    else:
        users.update_one({"_id": oid}, {"$set": {"privacy": original}})
    P._dead_until.clear(); P._sensitive_since.clear(); P._cache.clear()
    print("\n  (test frames removed, settings restored)")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
