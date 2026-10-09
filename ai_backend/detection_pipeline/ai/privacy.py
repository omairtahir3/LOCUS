"""Module A FE-4 and FE-5: the washroom rule, and the privacy switch.

Three states, because "stop recording" and "stop keeping recognisable pictures
of me" are different needs:

    off     nothing changes
    blur    every frame that reaches disk is pixelated past recognition first
    paused  no frame reaches disk at all

and two automatic rules on top, which need no switch at all:

    the washroom       the scene classifier already knows a bathroom (Toilet,
                       Bathtub, Toothbrush, Toilet Paper). The moment it says
                       so, capture goes dead for AUTO_DEAD_SECONDS and every
                       frame already written from that room is destroyed.
    a named place      a clinic, a neighbour's house: a fix inside the circle
                       is dead the same way.

THE RETROACTIVE HALF IS NOT OPTIONAL. Rooms are classified by the item
indexer, which runs behind the capture loop: by the time anything knows it is
a bathroom, the frame is on disk, a thumbnail may have been rendered from it,
and an event row points at it. A forward-only gate would let the first
washroom frames of every visit survive the feature built to prevent them. So
detection triggers a purge of the window that produced it -- image, sidecar,
thumbnail and the event's reference to it -- as well as closing the gate.

Blur is pixelate-then-blur, not blur alone. A Gaussian is a convolution and a
determined reader can sharpen some of it back; discarding the pixels by
downscaling to a 24th and stretching them out again destroys the information
instead of smearing it.

Read cheaply. The capture loop asks before every saved frame, so the user's
settings are cached for STATE_TTL_SECONDS. That bounds how long "I just
pressed the button" takes to take effect, which is why it is two seconds and
not a minute.
"""

from __future__ import annotations

import glob
import json
import os
import threading
import time
from datetime import datetime, timedelta, timezone

import cv2

# How long one sighting of a sensitive room keeps capture dead. Refreshed by
# every further sighting, so a long visit stays dead throughout; it only has to
# outlast the gap between frames plus the indexing lag.
AUTO_DEAD_SECONDS = float(os.environ.get("PRIVACY_AUTO_DEAD_SECONDS", 90))

# A purge reaches back to the first frame OF THIS VISIT, never a fixed window.
#
# It used to delete everything from the last 120 seconds, which destroyed the
# wearer's bedroom frames the moment they stepped into the washroom: the window
# had no idea which room each frame came from. The boundary is the capture time
# of the earliest frame classified as the sensitive room, so frames from the
# room BEFORE it are untouched.
#
# The cap exists only so a wild timestamp cannot delete an afternoon. Frames
# stop being captured as soon as the gate closes, so the real span a purge has
# to cover is the indexing lag -- a few seconds.
PURGE_MAX_LOOKBACK_SECONDS = float(os.environ.get("PRIVACY_PURGE_MAX_LOOKBACK_SECONDS", 300))

# While dead for a ROOM, a frame is taken every so often, classified in memory
# and thrown away, purely to notice that the wearer has left. Without it the
# only way back is the AUTO_DEAD_SECONDS timer, so walking out of the washroom
# meant standing in the bedroom unrecorded until it expired. Nothing is stored
# and no event is written from a probe.
PROBE_SECONDS = float(os.environ.get("PRIVACY_PROBE_SECONDS", 4.0))

# Settings cache. The bound on how stale "privacy mode is on" can be.
STATE_TTL_SECONDS = float(os.environ.get("PRIVACY_STATE_TTL_SECONDS", 2.0))

# A fix older than this says nothing about where the wearer is now, so it
# cannot be used to claim they are NOT in a sensitive place.
GPS_FRESH_SECONDS = float(os.environ.get("PRIVACY_GPS_FRESH_SECONDS", 300))

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
# Local mirror of auto_dead_until, so the capture loop does not wait on Mongo
# and still goes dead within one frame of the detection.
_dead_until: dict[str, tuple[float, str, str]] = {}   # (until, reason, kind)
# The capture time of the earliest frame of the current sensitive visit, which
# is how far back a purge may reach. Cleared when the gate lifts.
_sensitive_since: dict[str, float] = {}


def _db():
    from db_config import get_client, get_db_name
    return get_client()[get_db_name()]


def _ids(user_id: str):
    out = [str(user_id)]
    try:
        from bson import ObjectId
        out.append(ObjectId(str(user_id)))
    except Exception:
        pass
    return out


def settings(user_id: str, force: bool = False) -> dict:
    """This user's privacy settings, cached for STATE_TTL_SECONDS.

    Returns the permissive default on any failure. That is deliberate and it is
    the one judgement here worth arguing with: a privacy control that fails
    closed would stop a dementia camera recording whenever Mongo hiccupped,
    and silent total loss of function is its own harm. It fails OPEN and says
    so loudly in the log, so the failure is visible rather than mysterious.
    """
    if not user_id:
        return {"mode": "off", "sensitive_rooms": [], "sensitive_places": []}
    key = str(user_id)
    now = time.monotonic()
    if not force:
        with _lock:
            hit = _cache.get(key)
        if hit and (now - hit[0]) < STATE_TTL_SECONDS:
            return hit[1]
    out = {"mode": "off", "sensitive_rooms": [], "sensitive_places": []}
    try:
        doc = _db().users.find_one({"_id": _ids(key)[-1]}, {"privacy": 1}) or {}
        p = doc.get("privacy") or {}
        out = {
            "mode": p.get("mode") or "off",
            "sensitive_rooms": list(p.get("sensitive_rooms") or []),
            "sensitive_places": list(p.get("sensitive_places") or []),
        }
        until = p.get("auto_dead_until")
        if until:
            # Mongo hands back naive UTC. Mirrored locally in monotonic terms so
            # a second process's decision is honoured by this one.
            until = until.replace(tzinfo=until.tzinfo or timezone.utc)
            left = (until - datetime.now(timezone.utc)).total_seconds()
            if left > 0:
                with _lock:
                    prev = _dead_until.get(key)
                    if not prev or prev[0] < now + left:
                        _dead_until[key] = (now + left,
                                            p.get("auto_dead_reason") or "privacy",
                                            p.get("auto_dead_kind") or "room")
    except Exception as e:
        print(f"[Privacy] settings unavailable, assuming OFF: {e}")
    with _lock:
        _cache[key] = (now, out)
    return out


def _haversine_m(lat1, lng1, lat2, lng2) -> float:
    from math import asin, cos, radians, sin, sqrt
    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    a = (sin(dlat / 2) ** 2
         + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlng / 2) ** 2)
    return 2 * 6371000.0 * asin(min(1.0, sqrt(a)))


def in_sensitive_place(user_id: str) -> str | None:
    """The label of the sensitive place the wearer is in, or None.

    A stale fix returns None: not knowing where somebody is is not evidence
    that they are somewhere allowed, but neither is it grounds to go dead for
    ever on a fix from this morning.
    """
    places = settings(user_id).get("sensitive_places") or []
    if not places:
        return None
    try:
        fix = _db().locationlogs.find_one(
            {"user_id": {"$in": _ids(user_id)}}, sort=[("timestamp", -1)])
        if not fix or fix.get("lat") is None:
            return None
        ts = fix.get("timestamp")
        if ts is not None:
            ts = ts.replace(tzinfo=ts.tzinfo or timezone.utc)
            if (datetime.now(timezone.utc) - ts).total_seconds() > GPS_FRESH_SECONDS:
                return None
        for pl in places:
            try:
                d = _haversine_m(float(fix["lat"]), float(fix["lng"]),
                                 float(pl["lat"]), float(pl["lng"]))
            except Exception:
                continue
            if d <= float(pl.get("radius_m") or 50):
                return str(pl.get("label") or "a place you asked to keep private")
    except Exception as e:
        print(f"[Privacy] place check skipped: {e}")
    return None


def mark_dead(user_id: str, reason: str, seconds: float = AUTO_DEAD_SECONDS,
              kind: str = "room") -> None:
    """Close the gate for `seconds`, here and in every other process.

    `kind` says what closed it, because the way back differs: a room is probed
    out of, a place is re-read from GPS on every call, and a manual pause is
    lifted only by the wearer.
    """
    key = str(user_id)
    with _lock:
        prev = _dead_until.get(key)
        until = time.monotonic() + seconds
        if not prev or prev[0] < until:
            _dead_until[key] = (until, reason, kind)
    try:
        _db().users.update_one({"_id": _ids(key)[-1]}, {"$set": {
            "privacy.auto_dead_until": datetime.utcnow() + timedelta(seconds=seconds),
            "privacy.auto_dead_reason": reason,
            "privacy.auto_dead_kind": kind,
        }})
    except Exception as e:
        # The local mirror still holds, so this process stays dead either way.
        print(f"[Privacy] could not publish dead state: {e}")


def state(user_id: str) -> dict:
    """What capture should do for this user right now.

    {"capture": bool, "blur": bool, "reason": str|None}
    """
    if not user_id:
        return {"capture": True, "blur": False, "reason": None}
    key = str(user_id)
    s = settings(key)                      # also refreshes the dead mirror

    if s.get("mode") == "paused":
        return {"capture": False, "blur": False, "reason": "privacy mode", "kind": "mode"}

    with _lock:
        dead = _dead_until.get(key)
        if dead and dead[0] <= time.monotonic():
            # ── The visit is over, so FORGET WHERE IT STARTED ───────────────
            #
            # This was cleared only when a probe recognised another room, and
            # not when the gate simply timed out. A stale boundary then made
            # the NEXT detection purge from the PREVIOUS visit's start: a
            # bathroom frame at 17:14 set the boundary, the gate timed out at
            # 17:16, twenty-four minutes of ordinary recording followed, and a
            # second bathroom frame at 17:40 purged from 17:14 -- clamped only
            # by PURGE_MAX_LOOKBACK_SECONDS, which still destroyed five minutes
            # of the wearer's desk, including the one frame showing their
            # earbuds and phone put down together.
            #
            # With this, a purge can only ever reach back to the visit that
            # triggered it, which is seconds.
            _dead_until.pop(key, None)
            _sensitive_since.pop(key, None)
            dead = None
    if dead:
        # kind "room" is the one the caller may probe its way out of.
        return {"capture": False, "blur": False, "reason": dead[1],
                "kind": dead[2] if len(dead) > 2 else "room"}

    where = in_sensitive_place(key)
    if where:
        # Marked as well as reported, so the purge path and the other process
        # agree with this one.
        mark_dead(key, f"you are at {where}", kind="place")
        return {"capture": False, "blur": False,
                "reason": f"you are at {where}", "kind": "place"}

    return {"capture": True, "blur": s.get("mode") == "blur",
            "reason": None, "kind": None}


def blur_frame(frame):
    """A frame nobody can read, and nobody can sharpen back.

    Downscale to a 24th and stretch it out again: the detail is discarded
    rather than smeared, so there is nothing left to recover. The Gaussian
    afterwards only removes the block edges, which otherwise read as a
    deliberate censor bar over a face.
    """
    try:
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (max(1, w // 24), max(1, h // 24)),
                           interpolation=cv2.INTER_AREA)
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)
        return cv2.GaussianBlur(out, (31, 31), 0)
    except Exception as e:
        print(f"[Privacy] blur failed, frame NOT stored: {e}")
        return None            # refusing to store beats storing it sharp


def is_sensitive_room(user_id: str, room: str | None) -> bool:
    if not room:
        return False
    return room in (settings(user_id).get("sensitive_rooms") or [])


# ── the retroactive half ─────────────────────────────────────────────────────

def _storage_roots() -> list[str]:
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                        "keyframe_backend")
    return [os.path.normpath(os.path.join(base, d)) for d in (
        "keyframe_storage", "items_storage", "activities_storage",
        "social_storage", "medications_storage")]


def _thumb_dir() -> str:
    return os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..",
        "keyframe_backend", "thumb_cache"))


def _sidecar_time(meta: dict) -> float | None:
    """When the frame in this sidecar was captured, as a unix timestamp."""
    for field in ("timestamp", "saved_at"):
        raw = meta.get(field)
        if not isinstance(raw, str) or not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    return None


def purge_since(user_id: str, reason: str, since_epoch: float) -> dict:
    """Destroy this user's stored frames captured at or after `since_epoch`.

    Image, sidecar and any rendered thumbnail, across all five stores, and the
    event rows' references to them. The rows themselves stay, with
    privacy_redacted set: that the camera was running and a frame was dropped
    for privacy is the audit trail, and it is separate from the content, which
    is what has to go. Exactly the shape dismissing a face already uses.

    `since_epoch` is the capture time of the earliest frame of the sensitive
    visit, NOT a rolling window. This took a wearer's bedroom frames the first
    time it ran: a flat "everything from the last 120 seconds" cannot tell a
    washroom frame from the bedroom frame captured a minute earlier, and both
    went. Everything from before the room changed is now left alone.

    Returns {"files": n, "events": n, "since": epoch}.
    """
    key = str(user_id)
    # The cap is a guard against a wild timestamp, not the policy.
    cutoff = max(float(since_epoch), time.time() - PURGE_MAX_LOOKBACK_SECONDS)
    removed_ids: set[str] = set()
    files = 0

    for root in _storage_roots():
        # medications_storage is laid out by user like the rest; a store that
        # is not there yet simply contributes nothing.
        for meta_path in glob.glob(os.path.join(root, key, "*", "*.json")):
            try:
                with open(meta_path, "r") as f:
                    meta = json.load(f)
            except Exception:
                continue
            when = _sidecar_time(meta)
            # No usable timestamp: judge by the file itself rather than skip it.
            if when is None:
                try:
                    when = os.path.getmtime(meta_path)
                except OSError:
                    continue
            if when < cutoff:
                continue
            stem = os.path.splitext(os.path.basename(meta_path))[0]
            removed_ids.add(stem)
            for path in (meta_path, os.path.splitext(meta_path)[0] + ".jpg"):
                try:
                    os.remove(path)
                    files += 1
                except OSError:
                    pass

    # Thumbnails are derived copies keyed by id. Leaving them would keep a
    # readable picture of the washroom after the original was destroyed.
    for stem in removed_ids:
        for path in glob.glob(os.path.join(_thumb_dir(), stem + ".*")):
            try:
                os.remove(path)
                files += 1
            except OSError:
                pass

    events = 0
    if removed_ids:
        try:
            res = _db().eventlogs.update_many(
                {"user_id": {"$in": _ids(key)}, "keyframe_id": {"$in": list(removed_ids)}},
                {"$set": {"privacy_redacted": True, "privacy_reason": reason},
                 "$unset": {"keyframe_id": ""}})
            events = res.modified_count
        except Exception as e:
            print(f"[Privacy] could not redact event rows: {e}")

    if files or events:
        span = time.time() - cutoff
        print(f"[Privacy] {reason}: destroyed {files} file(s) captured in the "
              f"last {span:.0f}s of this visit and redacted {events} event(s)")
    return {"files": files, "events": events, "since": cutoff}


def enter_sensitive_room(user_id: str, room: str,
                         frame_epoch: float | None = None) -> dict:
    """A sensitive room was just recognised: close the gate and clean up.

    `frame_epoch` is when the frame being classified was CAPTURED, which is
    seconds before now -- classification runs behind the capture loop. It is
    the boundary of the purge, and the earliest one seen during a visit is the
    one that sticks, so a visit whose frames are classified out of order still
    cleans up from its true start.
    """
    key = str(user_id)
    reason = f"the {room} is private"
    ts = float(frame_epoch) if frame_epoch else time.time()
    with _lock:
        prev = _sensitive_since.get(key)
        if prev is None or ts < prev:
            _sensitive_since[key] = ts
        since = _sensitive_since[key]
    mark_dead(key, reason, kind="room")
    return purge_since(key, reason, since)


def left_sensitive_room(user_id: str, room: str | None) -> bool:
    """A frame says the wearer is no longer in a private room: open the gate.

    While the gate is shut nothing is captured, so nothing is classified, so
    without this the only way back was the AUTO_DEAD_SECONDS timer -- walking
    out of the washroom left the wearer standing in their bedroom, unrecorded,
    until it expired. The pipeline probes for exactly this (PROBE_SECONDS).

    Only a ROOM is lifted this way. A manual pause is the wearer's decision and
    a place is re-read from GPS on every call, so neither is touched here.
    Returns True when the gate was actually opened.
    """
    key = str(user_id)
    # Guarded HERE, not only in the caller. The caller does check, but this
    # function opens a privacy gate, and "no room recognised" is not evidence
    # the wearer has left one: an unclassifiable frame taken inside the
    # washroom would otherwise reopen it. Nor may the private room lift itself.
    if not room or is_sensitive_room(key, room):
        return False
    # Nothing resumes while the wearer has paused it by hand. Without this the
    # room state WAS lifted -- harmlessly, since state() reads the manual mode
    # first and still refuses capture -- and the log said "recording again"
    # while the camera stayed off. The gate was right and the message was a lie,
    # which is the harder kind of bug to find later.
    if settings(key).get("mode") == "paused":
        return False
    with _lock:
        dead = _dead_until.get(key)
        if not dead or dead[0] <= time.monotonic():
            return False
        if (dead[2] if len(dead) > 2 else "room") != "room":
            return False
        _dead_until.pop(key, None)
        _sensitive_since.pop(key, None)
    print(f"[Privacy] no longer in a private room"
          + (f" (now: {room})" if room else "") + "; recording again")
    try:
        _db().users.update_one({"_id": _ids(key)[-1]}, {"$set": {
            "privacy.auto_dead_until": None,
            "privacy.auto_dead_reason": None,
            "privacy.auto_dead_kind": None,
        }})
    except Exception as e:
        print(f"[Privacy] could not publish the lifted state: {e}")
    # The cached settings still hold the old auto_dead_until, and settings()
    # would mirror it straight back on the next read.
    with _lock:
        _cache.pop(key, None)
    return True
