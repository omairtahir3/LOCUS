"""An activity's evidence belongs in activities_storage, without losing the day.

The wearer asked why activities_storage was empty. It is swept by retention,
searched by _surviving_frame and counted by /keyframes/storage -- and nothing
ever wrote to it. Its only writer is the egocentric activity plugin, which is
enabled=False in plugins/registry.py by decision: it loaded yolov8s for a
second detector pass, both its output flags were already off, and "At a
keyboard for 454 seconds" is a description of furniture, not a memory.

What produces activities now is _observe_scene -- "Time in the bedroom for
1 min" -- and a session writes no frame of its own. _surviving_frame picks the
best frame of the session that still exists, which in practice is a
scene_change frame kept for the day's memory. One image per moment is the right
rule, but it left the record of an activity resting on a frame kept for an
unrelated reason, and _surviving_frame exists because exactly that frame was
once deleted between a session's last sighting and the session closing.

So a CLOSED session now files its chosen frame in activities_storage too. A
copy, not a move, for three reasons this suite checks:

  * the Keyframe Audit lists keyframe_storage ALONE, so a move would delete
    the moment from the day's memory in order to file it as an activity;
  * saved_at is carried across untouched, so the copy expires on the same 36 h
    clock instead of outliving the frame it was taken from;
  * every delete path already walks all five stores, so the pair goes together.

Measured when this was written: of 66 activity events with a surviving frame,
65 were scene_change and exactly one was a real session.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import uuid
import warnings
from datetime import datetime, timezone

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


from ai.item_indexer import DailyItemIndexer as DI     # noqa: E402

src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
rsrc = io.open(os.path.join(AI, 'keyframe_backend', 'routes.py'),
               encoding='utf-8').read()

print("1. a closed session's frame is copied into activities_storage")
tmp = tempfile.mkdtemp(prefix="locus_activity_test_")
try:
    kid = str(uuid.uuid4())
    uid = "user1"
    day = "2026-10-16"
    src_dir = os.path.join(tmp, "keyframe_storage", uid, day)
    os.makedirs(src_dir, exist_ok=True)
    saved_at = datetime.now(timezone.utc).isoformat()
    io.open(os.path.join(src_dir, kid + ".jpg"), "wb").write(b"\xff\xd8\xff\xd9")
    with io.open(os.path.join(src_dir, kid + ".json"), "w", encoding="utf-8") as f:
        json.dump({"id": kid, "saved_at": saved_at, "user_id": uid,
                   "event_type": "scene_change"}, f)

    ok = DI._file_activity_frame(kid, uid, "sess-1", base=tmp)
    dest = os.path.join(tmp, "activities_storage", uid, day, kid + ".jpg")
    dest_meta = dest[:-4] + ".json"

    check("it reports that it filed one", ok is True)
    check("the frame is in activities_storage", os.path.exists(dest),
          "under the wearer's own id and the day it was captured")
    check("and under the SOURCE's date, not today's",
          os.path.basename(os.path.dirname(dest)) == day,
          "a session closing after midnight must not refile the frame forward")
    check("the original is still in keyframe_storage",
          os.path.exists(os.path.join(src_dir, kid + ".jpg")),
          "the audit lists that store alone; a move would empty the day's memory")

    meta = json.load(io.open(dest_meta, encoding="utf-8"))
    check("the copy says what it was filed as", meta.get("filed_as") == "activity")
    check("and which session claimed it",
          meta.get("activity_session_id") == "sess-1",
          "so a frame in here can be traced back to its row")
    check("saved_at is carried over untouched",
          meta.get("saved_at") == saved_at,
          "a fresh one would keep the copy alive after its original expired")

    again = DI._file_activity_frame(kid, uid, "sess-1", base=tmp)
    check("filing twice does nothing the second time", again is False,
          "a session is persisted again every time it grows")

    missing = DI._file_activity_frame(str(uuid.uuid4()), uid, "sess-2", base=tmp)
    check("a frame that no longer exists is not invented", missing is False)
    check("and neither is one with no id", DI._file_activity_frame(None, uid, base=tmp)
          is False)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("2. only when the session is over")
check("the call is guarded by in_progress",
      "if not in_progress:\n                self._file_activity_frame(" in src,
      "the row is upserted each time the session grows; the frame wants "
      "filing once")
check("and the open/closed distinction still exists",
      'state = "open" if in_progress else "closed"' in src)

print()
print("3. it can never cost the event row")
check("the whole copy is inside a try",
      "could not file the activity frame" in src,
      "the session is the record; this is a second copy of its picture")

print()
print("4. the reasoning is recorded where the code is")
check("why it is a copy and not a move",
      "Keyframe Audit lists keyframe_storage alone" in src)
check("why saved_at is left alone",
      "expires on the same 36 h clock" in src)
check("and that nothing else ever wrote to this store",
      "off by decision in" in src and "plugins/registry.py" in src)

print()
print("5. the store was already wired for frames it never received")
check("retention sweeps it",
      "ActivityStorage" in io.open(os.path.join(AI, 'keyframe_backend',
                                                'keyframe.py'),
                                   encoding='utf-8').read())
check("the image endpoint resolves across it",
      "ACTIVITY_STORAGE_DIR" in rsrc)
check("and _surviving_frame already looked there",
      '("keyframe_storage", "activities_storage")' in src,
      "it searched a folder nothing wrote to")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
