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

# How far back a purge reaches when a sensitive room is recognised. Must cover
# the indexing lag -- the frame being classified now was captured seconds ago --
# plus the frames before it from the same visit.
PURGE_LOOKBACK_SECONDS = float(os.environ.get("PRIVACY_PURGE_LOOKBACK_SECONDS", 120))

# Settings cache. The bound on how stale "privacy mode is on" can be.
STATE_TTL_SECONDS = float(os.environ.get("PRIVACY_STATE_TTL_SECONDS", 2.0))

# A fix older than this says nothing about where the wearer is now, so it
# cannot be used to claim they are NOT in a sensitive place.
GPS_FRESH_SECONDS = float(os.environ.get("PRIVACY_GPS_FRESH_SECONDS", 300))

_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}
# Local mirror of auto_dead_until, so the capture loop does not wait on Mongo
# and still goes dead within one frame of the detection.
_dead_until: dict[str, tuple[float, str]] = {}


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
                        _dead_until[key] = (now + left, p.get("auto_dead_reason") or "privacy")
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


def mark_dead(user_id: str, reason: str, seconds: float = AUTO_DEAD_SECONDS) -> None:
    """Close the gate for `seconds`, here and in every other process."""
    key = str(user_id)
    with _lock:
        prev = _dead_until.get(key)
        until = time.monotonic() + seconds
        if not prev or prev[0] < until:
            _dead_until[key] = (until, reason)
    try:
        _db().users.update_one({"_id": _ids(key)[-1]}, {"$set": {
            "privacy.auto_dead_until": datetime.utcnow() + timedelta(seconds=seconds),
            "privacy.auto_dead_reason": reason,
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
        return {"capture": False, "blur": False, "reason": "privacy mode"}

    with _lock:
        dead = _dead_until.get(key)
    if dead and dead[0] > time.monotonic():
        return {"capture": False, "blur": False, "reason": dead[1]}

    where = in_sensitive_place(key)
    if where:
        # Marked as well as reported, so the purge path and the other process
        # agree with this one.
        mark_dead(key, f"you are at {where}")
        return {"capture": False, "blur": False, "reason": f"you are at {where}"}

    return {"capture": True, "blur": s.get("mode") == "blur", "reason": None}


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


def purge_recent(user_id: str, reason: str,
                 seconds: float = PURGE_LOOKBACK_SECONDS) -> dict:
    """Destroy every stored frame of this user from the last `seconds`.

    Image, sidecar and any rendered thumbnail, across all five stores, and the
    event rows' references to them. The rows themselves stay, with
    privacy_redacted set: that the camera was running and a frame was dropped
    for privacy is the audit trail, and it is separate from the content, which
    is what has to go. Exactly the shape dismissing a face already uses.

    Returns {"files": n, "events": n}.
    """
    key = str(user_id)
    cutoff = time.time() - seconds
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
        print(f"[Privacy] {reason}: destroyed {files} file(s) from the last "
              f"{seconds:.0f}s and redacted {events} event(s)")
    return {"files": files, "events": events}


def enter_sensitive_room(user_id: str, room: str) -> dict:
    """A sensitive room was just recognised: close the gate and clean up."""
    reason = f"the {room} is private"
    mark_dead(user_id, reason)
    return purge_recent(user_id, reason)
