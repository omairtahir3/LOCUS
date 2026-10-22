"""Privacy Mode: the washroom rule, and the switch (Module A FE-4/FE-5, 10 FE-3).

Three states -- off, blur, paused -- plus two automatic rules that need no
switch: a room the wearer named, and a place they named.

The part worth testing hardest is the retroactive half. Rooms are classified by
the item indexer, which runs BEHIND the capture loop, so by the time anything
knows it is a bathroom the frame is already on disk, a thumbnail may have been
rendered from it, and an event row points at it. A forward-only gate would let
the first washroom frames of every visit survive the feature built to prevent
them.

The other is that the blur is not reversible. A Gaussian is a convolution and a
determined reader can sharpen some of it back, so this discards the pixels by
downscaling to a 24th before stretching them out again.
"""
import glob
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
from db_config import get_client, get_db_name
from bson import ObjectId

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


def set_privacy(**kw):
    users.update_one({"_id": oid}, {"$set": {f"privacy.{k}": v for k, v in kw.items()}})
    P.settings(UID, force=True)          # drop the 2 s cache for the test


def restore():
    if original is None:
        users.update_one({"_id": oid}, {"$unset": {"privacy": ""}})
    else:
        users.update_one({"_id": oid}, {"$set": {"privacy": original}})
    P._dead_until.clear()
    P.settings(UID, force=True)


try:
    print("1. the three states, as the capture loop sees them")
    set_privacy(mode='off', auto_dead_until=None, auto_dead_reason=None,
                sensitive_rooms=['bathroom'], sensitive_places=[])
    P._dead_until.clear()
    st = P.state(UID)
    check("off: capture on, no blur", st["capture"] and not st["blur"])

    set_privacy(mode='blur')
    st = P.state(UID)
    check("blur: still capturing, but blurred", st["capture"] and st["blur"])

    set_privacy(mode='paused')
    st = P.state(UID)
    check("paused: nothing captured at all", not st["capture"] and not st["blur"],
          st["reason"])

    print()
    print("2. the blur cannot be sharpened back")
    set_privacy(mode='blur')
    # Something with real high-frequency detail, which is what a face is to a
    # sharpening filter.
    sharp = np.zeros((480, 640, 3), dtype=np.uint8)
    for i in range(0, 640, 8):
        sharp[:, i:i + 4] = 255
    cv2.putText(sharp, "READABLE", (40, 240), cv2.FONT_HERSHEY_SIMPLEX, 3, (0, 0, 255), 8)
    blurred = P.blur_frame(sharp)
    check("a frame comes back", blurred is not None and blurred.shape == sharp.shape)

    def detail(img):
        return float(cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY),
                                   cv2.CV_64F).var())
    d0, d1 = detail(sharp), detail(blurred)
    check("almost all the detail is gone", d1 < d0 * 0.02,
          f"{d0:.0f} -> {d1:.0f}, {(d1 / d0) * 100:.2f}% left")

    # The point of pixelating rather than blurring: an unsharp mask recovers a
    # lot of a Gaussian and nothing of discarded pixels.
    recovered = cv2.addWeighted(blurred, 2.5, cv2.GaussianBlur(blurred, (0, 0), 3), -1.5, 0)
    check("sharpening it back does not restore the detail", detail(recovered) < d0 * 0.15,
          f"after an unsharp mask: {detail(recovered):.0f} vs {d0:.0f} original")
    check("and it is not simply the original returned",
          not np.array_equal(blurred, sharp))

    print()
    print("3. a blur that fails refuses rather than storing a readable frame")
    check("garbage in, nothing out", P.blur_frame(None) is None,
          "the one path where a bug could leak a sharp frame")

    print()
    print("4. the rooms the wearer named")
    # The list is still the list. What changed is that ACTING on it is gated:
    # the automatic rule was switched off after it wiped a wearer sitting on
    # their couch, so is_sensitive_room answers for the gate and
    # would_be_sensitive_room answers for the list. See auto_room_off_test.
    set_privacy(mode='off', sensitive_rooms=['bathroom'])
    check("the washroom is named private", P.would_be_sensitive_room(UID, 'bathroom'))
    check("the kitchen is not", not P.would_be_sensitive_room(UID, 'kitchen'))
    check("and 'no room recognised' is not a private room",
          not P.would_be_sensitive_room(UID, None),
          "an unrecognised room must not go dark, or nothing is ever recorded")
    set_privacy(sensitive_rooms=['bathroom', 'bedroom'])
    check("more than one can be named", P.would_be_sensitive_room(UID, 'bedroom'))
    check("and the automatic rule acts on them again",
          P.AUTO_ROOM_PRIVACY is True,
          "re-armed 14 Oct on measurement; the wearer's own button and blur "
          "mode are unaffected either way")
    set_privacy(sensitive_rooms=['bathroom'])

    print()
    print("5. recognising one goes dead, and stays dead")
    set_privacy(mode='off', sensitive_rooms=['bathroom'],
                auto_dead_until=None, auto_dead_reason=None)
    P._dead_until.clear()
    check("capture is on before the washroom is seen", P.state(UID)["capture"])
    P.mark_dead(UID, "the bathroom is private", seconds=60)
    st = P.state(UID)
    check("and off immediately after", not st["capture"], st["reason"])
    check("the reason says which room", "bathroom" in (st["reason"] or ""))
    doc = users.find_one({"_id": oid}, {"privacy": 1})["privacy"]
    check("published to the database, so the OTHER process goes dead too",
          doc.get("auto_dead_until") is not None,
          "capture and classification run in different places")

    # It must expire: a single sighting cannot silence the camera for the day.
    P._dead_until.clear()
    users.update_one({"_id": oid}, {"$set": {
        "privacy.auto_dead_until": datetime.utcnow() - timedelta(seconds=5)}})
    P.settings(UID, force=True)
    check("a dead state in the past does not keep it dead", P.state(UID)["capture"],
          "the wearer leaves the room and recording resumes")

    print()
    print("6. the places the wearer named")
    fix = db.locationlogs.find_one({"user_id": {"$in": [oid, UID]}}, sort=[("timestamp", -1)])
    if fix and fix.get("lat") is not None:
        set_privacy(mode='off', sensitive_places=[
            {"label": "the clinic", "lat": float(fix["lat"]), "lng": float(fix["lng"]),
             "radius_m": 100}])
        P._dead_until.clear()
        where = P.in_sensitive_place(UID)
        # Only if that fix is still fresh; a stale one must NOT be used to claim
        # the wearer is there, which is the next assertion.
        ts = fix.get("timestamp")
        ts = ts.replace(tzinfo=ts.tzinfo or timezone.utc) if ts else None
        age = (datetime.now(timezone.utc) - ts).total_seconds() if ts else 1e9
        if age <= P.GPS_FRESH_SECONDS:
            check("a fix inside the circle is recognised", where == "the clinic")
            check("and capture goes dead for it", not P.state(UID)["capture"])
        else:
            check("a stale fix is NOT treated as being there", where is None,
                  f"last fix is {age / 60:.0f} min old, past the {P.GPS_FRESH_SECONDS / 60:.0f} "
                  f"min freshness bar; not knowing where somebody is is not permission")
        # A circle somewhere else must not match.
        set_privacy(sensitive_places=[
            {"label": "elsewhere", "lat": 0.0, "lng": 0.0, "radius_m": 50}])
        P._dead_until.clear()
        check("a circle on the other side of the world does not match",
              P.in_sensitive_place(UID) is None)
    else:
        print("     (no GPS fix on this account; place rules exercised via the API test)")

    set_privacy(sensitive_places=[])
    check("no places named means no place check at all",
          P.in_sensitive_place(UID) is None)

    print()
    print("7. the retroactive half: what was already stored is destroyed")
    # A frame exactly as the capture loop writes one, plus the thumbnail the
    # image route would have rendered from it, plus the event row pointing at it.
    kid = str(uuid.uuid4())
    day = datetime.now().strftime("%Y-%m-%d")
    root = os.path.join(AI, 'keyframe_backend', 'keyframe_storage', UID, day)
    os.makedirs(root, exist_ok=True)
    img_path = os.path.join(root, kid + '.jpg')
    meta_path = os.path.join(root, kid + '.json')
    cv2.imwrite(img_path, sharp)
    with open(meta_path, 'w') as f:
        json.dump({"id": kid, "user_id": UID, "event_type": "scene_change",
                   "timestamp": datetime.now().astimezone().isoformat(),
                   "file": kid + '.jpg'}, f)
    thumb_dir = os.path.join(AI, 'keyframe_backend', 'thumb_cache')
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_path = os.path.join(thumb_dir, f"{kid}.123.456.w240.jpg")
    cv2.imwrite(thumb_path, sharp)
    ev = db.eventlogs.insert_one({
        "user_id": oid, "event_type": "activity", "timestamp": datetime.utcnow(),
        "keyframe_id": kid, "details": {"action": "PRIVACYTEST"},
        "createdAt": datetime.utcnow()})

    check("the frame, its sidecar and its thumbnail exist to begin with",
          all(os.path.exists(p) for p in (img_path, meta_path, thumb_path)))

    # purge_since, not a rolling window: the boundary is the capture time of
    # the visit's first frame. See washroom_exit_test.py for why.
    res = P.purge_since(UID, "the bathroom is private", time.time() - 120)
    check("the image is gone", not os.path.exists(img_path))
    check("the sidecar is gone", not os.path.exists(meta_path))
    check("and so is the rendered thumbnail", not os.path.exists(thumb_path),
          "a derived copy would otherwise outlive the original it came from")
    row = db.eventlogs.find_one({"_id": ev.inserted_id})
    check("the event no longer points at any image", not row.get("keyframe_id"))
    check("but the event itself survives, marked", row.get("privacy_redacted") is True,
          "that the camera was running is the audit trail; the picture is the content")
    check("and it records why", "bathroom" in (row.get("privacy_reason") or ""))
    check("the purge reports what it did", res["files"] >= 3 and res["events"] >= 1,
          f"{res['files']} files, {res['events']} events")

    print()
    print("8. a purge does not reach beyond its window")
    old_kid = str(uuid.uuid4())
    os.makedirs(root, exist_ok=True)
    old_img = os.path.join(root, old_kid + '.jpg')
    old_meta = os.path.join(root, old_kid + '.json')
    cv2.imwrite(old_img, sharp)
    with open(old_meta, 'w') as f:
        json.dump({"id": old_kid, "user_id": UID,
                   "timestamp": (datetime.now().astimezone()
                                 - timedelta(hours=3)).isoformat()}, f)
    P.purge_since(UID, "test", time.time() - 60)
    check("a frame from three hours ago is untouched", os.path.exists(old_img),
          "privacy mode is not a delete-everything button")
    for p in (old_img, old_meta):
        try:
            os.remove(p)
        except OSError:
            pass

    print()
    print("9. the wiring: the gate is where every stored frame passes")
    import inspect
    kf = open(os.path.join(AI, 'keyframe_backend', 'keyframe.py'), encoding='utf-8').read()
    cap = kf[kf.index("def capture_event"):kf.index("def maybe_capture_coverage")]
    check("capture_event asks before anything else",
          cap.index("privacy") < cap.index("cooldown = EVENT_COOLDOWN_SECONDS"),
          "a frame refused on privacy must not consume the cooldown either")
    # The blur moved out of capture_event and into the write itself. There are
    # five stores and four separate face-crop writes, and blurring at each
    # caller meant one of them would be missed -- and blurring the frame handed
    # to the indexer as well switched every detector off for as long as blur
    # was on.
    save = kf[kf.index("    def save(self, keyframe_id"):kf.index("def load_frame")]
    check("the blur happens where the file is written", "blur_frame" in save)
    check("and before the write, not after",
          save.index("blur_frame") < save.index("cv2.imwrite"))
    check("a failed blur refuses to write rather than writing it readable",
          "refusing to write" in save)
    check("the frame handed to the indexer is never the blurred one",
          "frame if index_frame is None else index_frame" in save,
          "privacy costs recognisable pictures, not the detectors")

    ind = open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
    obs = ind[ind.index("def _observe_scene"):]
    obs = obs[:obs.index("\n    def ", 10)]
    check("the room check runs before the session tracker sees it",
          obs.index("is_sensitive_room") < obs.index("tracker.observe"),
          "no washroom session is ever opened, named or given a cover photo")
    check("and it tells the caller to stop", "return True" in obs)
    check("the caller does stop",
          "if self._observe_scene(scene_detections, user_id_str, keyframe_id, metadata):" in ind
          and "enter_sensitive_room" in ind)

    pl = open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()
    check("analysis is paused too, not only storage",
          'if not _priv["capture"]:' in pl,
          'FE-4 says "pause all recording AND analysis"')
    # Scoped to the branch itself rather than a fixed number of characters after
    # it. The first version searched the next 1800 chars and broke the moment the
    # probe block was inserted between the two strings: it was measuring
    # distance, not behaviour.
    _dead_branch = pl[pl.index('if not _priv["capture"]:'):]
    _dead_branch = _dead_branch[:_dead_branch.index("continue")]
    check("the liveness heartbeat deliberately keeps running",
          "_log_heartbeat_to_db" in _dead_branch,
          "or a long shower would tell a caregiver the camera had failed")
    check("and a probe goes out so leaving the room is noticed",
          "privacy_probe" in _dead_branch,
          "the gate stops capture, so nothing else could tell they had left")
    check("medication evidence is blurred too",
          "if _priv_blur:" in pl,
          "it writes its own frames and never passes capture_event")

finally:
    restore()
    db.eventlogs.delete_many({"details.action": "PRIVACYTEST"})
    print("\n  (settings restored, test rows removed)")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
