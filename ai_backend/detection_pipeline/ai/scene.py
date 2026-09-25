"""Scene (room) classification and session aggregation for LOCUS.

Replaces per-frame activity claims ("Typing.", "Drinking.") with time-bounded
scene sessions ("Kitchen activity for 25 minutes"). Per-frame labels of any kind
hallucinate: scoring rooms frame-by-frame over one continuous session in a
single room returned office x30, bedroom x5, dining x4 and nothing x20. The
room is a property of a stretch of time, not of a frame, so the unit of
reporting has to be a session.

Calibrated against 22 hand-labelled chest-cam keyframes covering the wearer's
living room (14), kitchen (3) and bedroom/study (5).

Two rules do the work:

1. DEFINING OBJECT. A room can only win if at least one object that actually
   defines it was detected (weight >= 0.8: Refrigerator for a kitchen, Bed or
   Pillow for a bedroom, Couch or TV for a living room). Without this rule,
   weak ubiquitous classes accumulate into confident nonsense -- "Desk" alone
   fired in 33 frames and made a living room score as an office. Desk, Chair,
   Book, Laptop and Keyboard carry NO weight for this reason: they appear in
   every room in this home.

2. MARGIN. The winner must clear MIN_SCENE_SCORE and beat the runner-up by
   MIN_SCENE_MARGIN, otherwise the scene is reported as unknown.

Measured on the calibration set: 0 wrong of 22 frames, 4 confident, 18 unknown.
Session-level, accumulating evidence across each room's frames: kitchen and
bedroom both resolve correctly. The living room resolves to UNKNOWN, because in
all 14 frames the camera pointed at the wearer's lap and laptop and never once
saw the couch or the TV. That is the intended behaviour -- no evidence means no
claim, not a guess.
"""

from __future__ import annotations

import os
import time
import uuid
from collections import defaultdict
from typing import Any, Optional

# Objects365 class name -> how strongly it implies the room.
# 1.0 = defining (this object essentially only exists in that room)
# 0.5-0.8 = supporting
# Anything that appears across rooms is deliberately absent, not down-weighted.
SCENE_WEIGHTS: dict[str, dict[str, float]] = {
    # Counter-level objects are defining here, not merely supporting. A chest
    # cam standing at a worktop sees a pot, a kettle and a sink; the big
    # appliances that used to be the only way to unlock this room sit behind or
    # beside the wearer and never enter frame. In a real recording the wearer
    # spent minutes in this kitchen and it scored ZERO every time, because
    # Refrigerator/Microwave/Oven were never in view -- while a dark appliance
    # front read as "Monitor/TV" and the room was reported as a living room.
    "kitchen": {
        "Refrigerator": 1.0, "Microwave": 1.0, "Oven": 1.0, "Gas stove": 1.0,
        "Induction Cooker": 1.0, "Rice Cooker": 1.0, "Dishwasher": 1.0,
        "Extractor": 1.0, "Coffee Machine": 0.9,
        "Pot": 0.8, "Kettle": 0.8, "Cutting/chopping Board": 0.8,
        "Tea pot": 0.8, "Blender": 0.8,
        "Sink": 0.6, "Bowl/Basin": 0.3, "Cabinet/shelf": 0.3,
    },
    "bedroom": {
        "Bed": 1.0, "Pillow": 0.9, "Nightstand": 0.9, "Wardrobe": 0.8,
        "Lamp": 0.4, "Mirror": 0.3,
    },
    # Monitor/TV is NOT defining, at any weight. A screen exists in every room
    # of a modern home, and it is the class most easily confused with the dark
    # rectangular front of a microwave or an oven. Both false "Sitting in the
    # living room" sessions in the real recording came from Monitor/TV ALONE --
    # one of them from a single detection at 0.49 -- while the wearer was in the
    # kitchen. A couch or a coffee table defines this room; a screen does not.
    "living": {
        "Couch": 1.0, "Coffee Table": 0.8,
        "Monitor/TV": 0.5, "Remote": 0.6,
        "Picture/Frame": 0.3, "Candle": 0.3,
    },
    # Sink and Towel are supporting, not defining: both are as common in a
    # kitchen as in a bathroom, and as a defining pair they let a kitchen sink
    # open a bathroom session. A toilet or a bathtub is what actually settles it.
    "bathroom": {
        "Toilet": 1.0, "Bathtub": 1.0,
        "Sink": 0.6, "Towel": 0.55,
        "Toothbrush": 0.7, "Soap": 0.7, "Toilet Paper": 0.7, "Toiletry": 0.6,
    },
    "dining": {
        "Dining Table": 1.0, "Chopsticks": 0.6, "Plate": 0.4,
        "Fork": 0.4, "Spoon": 0.4, "Knife": 0.4,
    },
    # Office/classroom. None of these exist in the calibration home, so this
    # mapping is UNVALIDATED against real frames -- it is built from the
    # Objects365 class list, not measured. The defining-object rule keeps it
    # safe: without a whiteboard, projector or printer in view it cannot fire.
    # Desk is excluded on purpose; it fired in bedrooms and living rooms alike.
    "office": {
        "Blackboard/Whiteboard": 1.0, "Projector": 1.0, "Printer": 0.9,
        "Board Eraser": 0.8, "Globe": 0.6, "Stapler": 0.6, "Folder": 0.4,
        "Calculator": 0.4, "Notepaper": 0.3,
    },
    # Deliberately NO "outdoor" scene. Environment sessions are for rooms in
    # the home; the wearer being outside is not something the feed should
    # report as an activity. Outdoors, no room's defining objects are in view,
    # so the tracker reports unknown and no session is written -- which is the
    # intended silence. Item tracking continues regardless of scene (see
    # item_indexer.py); "outdoors" for that purpose is a GPS question, not a
    # vision one.
}

DEFINING_OBJECTS: dict[str, set[str]] = {
    room: {cls for cls, w in weights.items() if w >= 0.8}
    for room, weights in SCENE_WEIGHTS.items()
}

MIN_SCENE_SCORE = 0.35     # below this, no room is claimed
MIN_SCENE_MARGIN = 0.15    # winner must beat the runner-up by this much

# The defining object must be seen CLEARLY, not merely seen. A real recording
# opened a 59-second "Sitting in the living room" session off one detection of
# Monitor/TV at 0.49 -- a coin flip, in a kitchen. A class that unlocks a whole
# room has to be more than half believed.
MIN_DEFINING_CONF = 0.55

# One object is not a room. The same false session had a single contributing
# class; every correct session in the calibration set had several. Requiring two
# distinct classes costs nothing where the evidence is real and removes the
# entire family of one-detection rooms.
MIN_CONTRIBUTING_CLASSES = 2

# A session needs at least this many CONFIRMED sightings to be written. One
# sighting cannot establish a span of time: the false living-room session above
# reported 59 seconds from frames=1, its duration made up entirely of later
# frames that recognised nothing and merely coasted.
MIN_SESSION_FRAMES = 2

# How much evidence is needed to OVERWRITE an established room. Taking over
# from an open session needs this many classified observations of the new room;
# opening the very first session needs only one, since there is nothing to
# overwrite. Sitting in the living room was being relabelled bedroom off a
# single stray classification, so a confirmed environment now has to be
# outvoted, not merely contradicted once. Frames that classify as unknown do
# not break a session -- the wearer looking down at their lap is not a change
# of room.
# 2, not 3: at 3 the real recording lost its bedroom and living-room sessions
# entirely, since each was confirmed in only two frames. 2 still means a single
# stray classification cannot displace an established room -- and because
# classify_scene already requires the winner to beat the runner-up by
# MIN_SCENE_MARGIN, two agreeing frames are two frames where the new room
# genuinely out-scored the old one.
SCENE_SWITCH_FRAMES = 2

# Those observations must also fall within this window of each other. Without
# it, two stray bedroom frames twenty minutes apart counted as agreement
# because unknown frames in between neither confirmed nor reset the tally.
#
# 300s, not 120s: keyframes are sparse and a room is often only recognised when
# the camera happens to face it. The real recording's two living-room sightings
# were 185s apart -- genuinely the same visit -- and a 120s window discarded the
# session entirely. 300s still rejects the twenty-minutes-apart case.
SCENE_PENDING_WINDOW = 300

# How long a session may coast on unknown frames before it is closed at its last
# confirmed sighting. Unknown frames must extend a session -- the wearer looking
# down at their lap is not a change of room -- but extending it indefinitely is
# wrong: a bedroom sighting at 03:16 followed by 19 minutes of unrecognised
# frames produced a single "bedroom, 19 min" session covering a stretch the
# wearer had long since walked out of. Beyond this gap we have simply lost
# track, and the honest end of the session is the last time we actually saw the
# room.
#
# 90s, not 180s: at 180 a bedroom session confirmed at 06:54 coasted for 154
# seconds straight through a trip to the kitchen, because the kitchen frames in
# between recognised nothing and neither confirmed nor closed it. The wearer's
# kitchen visit was reported as time in the bedroom. Frames are much denser now
# that capture is event-driven rather than motion-driven, so 90s is still
# several frames of tolerance for looking down at a lap.
SCENE_STALE_SECONDS = 90

# Close and immediately reopen a session that runs this long. Nothing is written
# until a session ENDS, so a wearer who stays in one room for forty minutes sees
# nothing in the feed for forty minutes, which reads as a broken system. This
# bounds that delay: a long stay becomes a sequence of chunks rather than one
# block that arrives late.
MAX_SESSION_SECONDS = float(os.environ.get("MAX_SESSION_SECONDS", 600))

# A session shorter than this is noise (walking through a room), not an event.
# 10s, because keyframes arrive roughly every 14 seconds: a session is measured
# from its first sighting to its last CONFIRMED sighting, so a genuine two-frame
# visit spans only ~14s and a 30s floor silently discarded a real trip to the
# kitchen. The defining-object rule keeps precision high (0 wrong across the
# 22-frame calibration set), so short sessions here are real visits rather than
# noise, and dropping them loses information a memory aid actually wants.
MIN_SESSION_SECONDS = 10


def explain_scene(detections: dict[str, float]) -> str:
    """Why no room was claimed, in one short phrase.

    Without this, "no room was recognised" is indistinguishable from "the
    classifier never ran", "the detector saw nothing" and "the evidence was one
    point short". Those need completely different fixes, and telling them apart
    from database residue afterwards is guesswork.
    """
    if not detections:
        return "the detector found no objects at all"

    best_room, best_note = None, None
    for room, weights in SCENE_WEIGHTS.items():
        defining = DEFINING_OBJECTS[room] & detections.keys()
        if not defining:
            continue
        strongest = max(detections[c] for c in defining)
        if strongest < MIN_DEFINING_CONF:
            note = (f"{room}: {max(defining, key=lambda c: detections[c])} only "
                    f"{strongest:.2f}, needs {MIN_DEFINING_CONF}")
        else:
            contributing = [c for c in weights if c in detections]
            if len(contributing) < MIN_CONTRIBUTING_CLASSES:
                note = (f"{room}: only {contributing} matched, needs "
                        f"{MIN_CONTRIBUTING_CLASSES} different objects")
            else:
                note = f"{room}: scored but lost on score or margin"
        if best_note is None:
            best_room, best_note = room, note
    if best_note:
        return best_note
    return ("no room's defining object was in view (a bed, a fridge, a couch, "
            "a toilet or a dining table)")


def validate_against_model(model_names) -> list[str]:
    """Report weight keys that no Objects365 class matches.

    A misspelled class name is invisible at runtime: the key simply never
    appears in a detections dict, so the room silently loses that evidence
    forever and nothing is logged. Called once at startup so a typo is loud.
    Returns the offending names (empty when all are real).
    """
    try:
        known = set(model_names.values()) if isinstance(model_names, dict) else set(model_names)
    except Exception:
        return []
    used = {cls for weights in SCENE_WEIGHTS.values() for cls in weights}
    unknown = sorted(used - known)
    if unknown:
        print(f"[scene] WARNING: {len(unknown)} scene weight keys match no "
              f"Objects365 class and can never fire: {unknown}")
    return unknown


def classify_scene(detections: dict[str, float]) -> tuple[Optional[str], float, dict[str, float]]:
    """Classify one frame's room from {objects365_class_name: confidence}.

    Returns (room or None, winning score, all room scores).
    """
    scores: dict[str, float] = {}
    for room, weights in SCENE_WEIGHTS.items():
        # The room is unlocked only by a defining object seen clearly enough.
        if not any(detections.get(cls, 0.0) >= MIN_DEFINING_CONF
                   for cls in DEFINING_OBJECTS[room]):
            scores[room] = 0.0
            continue
        contributing = [cls for cls in weights if cls in detections]
        if len(contributing) < MIN_CONTRIBUTING_CLASSES:
            scores[room] = 0.0
            continue
        scores[room] = sum(weights[cls] * detections[cls] for cls in contributing)

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    top, top_score = ranked[0]
    runner = ranked[1][1] if len(ranked) > 1 else 0.0
    if top_score < MIN_SCENE_SCORE or (top_score - runner) < MIN_SCENE_MARGIN:
        return None, top_score, scores
    return top, top_score, scores


class SceneSessionTracker:
    """Collapses a stream of per-frame scene guesses into time-bounded sessions.

    Feed it one classified frame at a time; it returns a completed session dict
    at the moment a new scene takes over, and flush() closes the final one.
    """

    def __init__(self):
        self._current: Optional[str] = None
        self._started_at: Optional[float] = None
        self._last_seen: Optional[float] = None
        self._last_confirmed: Optional[float] = None
        self._pending: Optional[str] = None
        self._pending_count = 0
        self._pending_since: Optional[float] = None
        self._evidence: dict[str, float] = defaultdict(float)
        self._frames = 0
        # The best frame of THIS session, kept so the session can illustrate
        # itself. The caller used to attach whatever frame was in hand when the
        # session closed, which is by definition a frame of the room that had
        # just displaced it: every "Kitchen activity" in the real recording
        # carried a photo of the bedroom the wearer walked into next.
        self._best_kf: Optional[str] = None
        self._best_score = -1.0
        # Stable identity for the OPEN session, so it can be written to the
        # database while it is still running and updated in place as it grows.
        self._session_id: Optional[str] = None

    def snapshot(self, timestamp: Optional[float] = None) -> Optional[dict[str, Any]]:
        """The open session as it stands, without closing it.

        Sessions used to reach the database only when they ENDED. Standing in
        one room meant the feed showed nothing at all for as long as the wearer
        stayed there, and a run that was killed rather than stopped cleanly
        never flushed, so the session was lost outright. Writing the session
        while it is open fixes both: it appears within a couple of confirmed
        frames and survives a hard stop.

        Returns None until the session would qualify to be written at all, so
        an in-progress record never claims more than a closed one would.
        """
        if self._current is None or self._started_at is None:
            return None
        end = self._last_confirmed or self._started_at
        duration = max(0.0, end - self._started_at)
        if duration < MIN_SESSION_SECONDS or self._frames < MIN_SESSION_FRAMES:
            return None
        return self._describe(self._current, self._started_at, end, duration,
                              dict(self._evidence), self._frames, self._best_kf,
                              in_progress=True)

    def observe(self, room: Optional[str], detections: dict[str, float],
                timestamp: Optional[float] = None,
                keyframe_id: Optional[str] = None,
                score: float = 0.0) -> Optional[dict[str, Any]]:
        ts = timestamp if timestamp is not None else time.time()

        if room is None:
            # Unknown frames extend the current session, but only so far.
            if self._current is not None:
                anchor = self._last_confirmed or self._started_at or ts
                if (ts - anchor) > SCENE_STALE_SECONDS:
                    return self._close(anchor)
                self._last_seen = ts
            return None

        if room == self._current:
            self._last_seen = ts
            self._last_confirmed = ts
            self._frames += 1
            self._pending = None
            self._pending_count = 0
            for cls, conf in detections.items():
                self._evidence[cls] = max(self._evidence[cls], conf)
            # Illustrate the session with the frame that recognised the room
            # most clearly, not the first or the last one.
            if keyframe_id and score > self._best_score:
                self._best_kf, self._best_score = keyframe_id, score
            # A long stay is reported in chunks rather than withheld until the
            # wearer finally leaves (see MAX_SESSION_SECONDS).
            if self._started_at is not None and (ts - self._started_at) >= MAX_SESSION_SECONDS:
                completed = self._close(ts)
                self._current = room
                self._started_at = ts
                self._session_id = uuid.uuid4().hex
                self._last_seen = ts
                self._last_confirmed = ts
                self._frames = 1
                self._evidence = defaultdict(float)
                for cls, conf in detections.items():
                    self._evidence[cls] = max(self._evidence[cls], conf)
                self._best_kf, self._best_score = keyframe_id, score
                return completed
            return None

        # A different room — require it to persist before switching.
        if room == self._pending and self._pending_since is not None                 and (ts - self._pending_since) <= SCENE_PENDING_WINDOW:
            self._pending_count += 1
        else:
            self._pending = room
            self._pending_count = 1
            self._pending_since = ts
        # Opening the first session needs no hysteresis; there is nothing to
        # overwrite. Displacing an established room does.
        needed = 1 if self._current is None else SCENE_SWITCH_FRAMES
        if self._pending_count < needed:
            return None

        # The new session began when the room was FIRST seen, not when
        # hysteresis confirmed it, and the old one ended there too. Dating both
        # from the confirmation frame charged the hysteresis delay to the old
        # session and erased it from the new one, collapsing short sessions to
        # near-zero duration so they fell under MIN_SESSION_SECONDS and vanished.
        switch_ts = self._pending_since if self._pending_since is not None else ts
        completed = self._close(switch_ts)
        self._current = room
        self._started_at = switch_ts
        self._session_id = uuid.uuid4().hex
        self._last_seen = ts
        self._last_confirmed = ts
        # The pending sightings ARE confirmed sightings of this room; they are
        # what proved the switch. Resetting to 1 discarded them, so the first
        # session after every room change under-counted its frames by one and a
        # genuine short visit was dropped by MIN_SESSION_FRAMES.
        self._frames = max(1, self._pending_count)
        self._evidence = defaultdict(float)
        for cls, conf in detections.items():
            self._evidence[cls] = max(self._evidence[cls], conf)
        # This frame belongs to the NEW session, never to the one just closed.
        self._best_kf, self._best_score = keyframe_id, score
        self._pending = None
        self._pending_count = 0
        self._pending_since = None
        return completed

    def flush(self, timestamp: Optional[float] = None) -> Optional[dict[str, Any]]:
        """Close the open session, e.g. when the stream stops."""
        return self._close(timestamp if timestamp is not None else time.time())

    def _close(self, ts: float) -> Optional[dict[str, Any]]:
        if self._current is None or self._started_at is None:
            return None
        start = self._started_at
        # End at the last time the room was actually confirmed. Trailing unknown
        # frames are not evidence the wearer was still there.
        end = self._last_confirmed or self._last_seen or ts
        duration = max(0.0, end - start)
        room, evidence, frames = self._current, dict(self._evidence), self._frames
        best_kf, session_id = self._best_kf, self._session_id
        self._current = None
        self._started_at = None
        self._last_seen = None
        self._last_confirmed = None
        self._evidence = defaultdict(float)
        self._frames = 0
        self._best_kf, self._best_score = None, -1.0
        self._session_id = None
        if duration < MIN_SESSION_SECONDS or frames < MIN_SESSION_FRAMES:
            return None
        return self._describe(room, start, end, duration, evidence, frames,
                              best_kf, in_progress=False, session_id=session_id)

    def _describe(self, room, start, end, duration, evidence, frames, best_kf,
                  in_progress, session_id=None) -> dict[str, Any]:
        """One shape for a session, open or closed, so an in-progress record
        and the final one cannot drift apart."""
        return {
            "scene": room,
            "session_id": session_id or self._session_id,
            "in_progress": in_progress,
            "keyframe_id": best_kf,
            "started_at": self._fmt(start),
            "start_ts": start,
            "end_ts": end,
            "duration_seconds": round(duration),
            "keyframes": frames,
            "evidence": {k: round(v, 2) for k, v in sorted(
                evidence.items(), key=lambda kv: -kv[1])[:8]},
            "label": describe_session(room, start, duration, evidence),
        }

    @staticmethod
    def _fmt(ts: float) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(ts))


# Time windows that give a scene a human name. Deliberately conservative: only
# a kitchen has meal-specific naming, because only cooking objects justify it.
MEAL_WINDOWS = (
    (5, 11, "Breakfast preparation"),
    (11, 15, "Lunch preparation"),
    (17, 22, "Dinner preparation"),
)

SCENE_TITLES = {
    "kitchen": "Kitchen activity",
    "bedroom": "Time in the bedroom",
    "living": "Sitting in the living room",
    "bathroom": "Bathroom",
    "dining": "At the dining table",
    "office": "Desk work",
}


# ── Activity sessions ───────────────────────────────────────────────────────
#
# Per-frame activity labels were switched off (EMIT_PER_FRAME_ACTIVITY_EVENTS)
# because they hallucinated: a bottle on a far table beat a laptop at 0.94 and
# logged "Drinking." while the wearer typed. Switching them off removed the
# false claims and also removed the true ones, so using a phone for twenty
# minutes produced no record at all.
#
# The fix is the one that worked for rooms: an activity is a property of a
# STRETCH OF TIME, not of a frame. A single frame's guess proves nothing, but the
# same guess repeated across a span is evidence. One stray "Drinking." among
# twenty "Using a phone." cannot open a session; twenty minutes of phone use is
# reported once, with its duration.
ACTIVITY_CONFIRM_FRAMES = 3      # agreeing observations needed to open a session
ACTIVITY_PENDING_WINDOW = 90     # ...and they must fall within this many seconds
ACTIVITY_STALE_SECONDS = 150     # unseen for this long: close at last sighting
MIN_ACTIVITY_SESSION_SECONDS = 20


class ActivitySessionTracker:
    """Collapses per-frame activity guesses into confirmed, timed sessions.

    Feed it one observation at a time. Returns a completed session dict when a
    new activity takes over, and flush() closes the final one.
    """

    def __init__(self):
        self._current: Optional[str] = None
        self._started_at: Optional[float] = None
        self._last_confirmed: Optional[float] = None
        self._pending: Optional[str] = None
        self._pending_count = 0
        self._pending_since: Optional[float] = None
        self._confs: list[float] = []
        self._objects: dict[str, float] = defaultdict(float)
        self._frames = 0
        # Same reason as SceneSessionTracker._best_kf: a frame grabbed when the
        # session closes shows whatever the wearer moved on to, not the activity
        # being reported.
        self._best_kf: Optional[str] = None
        self._best_score = -1.0
        self._session_id: Optional[str] = None

    def snapshot(self, timestamp: Optional[float] = None) -> Optional[dict[str, Any]]:
        """The open activity as it stands, without closing it.

        Same reason as SceneSessionTracker.snapshot: an activity that runs for
        twenty minutes should not be invisible for twenty minutes.
        """
        if self._current is None or self._started_at is None:
            return None
        end = self._last_confirmed or self._started_at
        duration = max(0.0, end - self._started_at)
        if duration < MIN_ACTIVITY_SESSION_SECONDS or self._frames < ACTIVITY_CONFIRM_FRAMES:
            return None
        return self._describe(self._current, self._started_at, end, duration,
                              list(self._confs), dict(self._objects), self._frames,
                              self._best_kf, in_progress=True)

    def observe(self, activity: Optional[str], confidence: float = 0.0,
                objects: Optional[dict[str, float]] = None,
                timestamp: Optional[float] = None,
                keyframe_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        ts = timestamp if timestamp is not None else time.time()
        objects = objects or {}

        if activity is None:
            if self._current is not None:
                anchor = self._last_confirmed or self._started_at or ts
                if (ts - anchor) > ACTIVITY_STALE_SECONDS:
                    return self._close(anchor)
            return None

        if activity == self._current:
            self._last_confirmed = ts
            self._frames += 1
            self._confs.append(confidence)
            for k, v in objects.items():
                self._objects[k] = max(self._objects[k], v)
            if keyframe_id and confidence > self._best_score:
                self._best_kf, self._best_score = keyframe_id, confidence
            self._pending = None
            self._pending_count = 0
            # Same chunking as scene sessions: a long activity is reported as
            # it goes rather than held back until it finally ends.
            if self._started_at is not None and (ts - self._started_at) >= MAX_SESSION_SECONDS:
                completed = self._close(ts)
                self._current = activity
                self._started_at = ts
                self._session_id = uuid.uuid4().hex
                self._last_confirmed = ts
                self._frames = ACTIVITY_CONFIRM_FRAMES
                self._confs = [confidence]
                self._objects = defaultdict(float)
                for k, v in objects.items():
                    self._objects[k] = max(self._objects[k], v)
                self._best_kf, self._best_score = keyframe_id, confidence
                return completed
            return None

        # A different activity has to persist before it displaces anything.
        if (activity == self._pending and self._pending_since is not None
                and (ts - self._pending_since) <= ACTIVITY_PENDING_WINDOW):
            self._pending_count += 1
        else:
            self._pending = activity
            self._pending_count = 1
            self._pending_since = ts

        if self._pending_count < ACTIVITY_CONFIRM_FRAMES:
            return None

        # Date the new session from the FIRST sighting, not the confirmation, so
        # the hysteresis delay is not charged to the wrong session.
        switch_ts = self._pending_since if self._pending_since is not None else ts
        completed = self._close(switch_ts)
        self._current = activity
        self._started_at = switch_ts
        self._session_id = uuid.uuid4().hex
        self._last_confirmed = ts
        self._frames = self._pending_count
        self._confs = [confidence]
        self._objects = defaultdict(float)
        for k, v in objects.items():
            self._objects[k] = max(self._objects[k], v)
        # Belongs to the NEW session, never to the one just closed.
        self._best_kf, self._best_score = keyframe_id, confidence
        self._pending = None
        self._pending_count = 0
        self._pending_since = None
        return completed

    def flush(self, timestamp: Optional[float] = None) -> Optional[dict[str, Any]]:
        return self._close(timestamp if timestamp is not None else time.time())

    def _close(self, ts: float) -> Optional[dict[str, Any]]:
        if self._current is None or self._started_at is None:
            return None
        start = self._started_at
        end = self._last_confirmed or ts
        duration = max(0.0, end - start)
        activity, frames = self._current, self._frames
        confs, objects = list(self._confs), dict(self._objects)
        best_kf, session_id = self._best_kf, self._session_id
        self._current = None
        self._started_at = None
        self._last_confirmed = None
        self._confs = []
        self._objects = defaultdict(float)
        self._frames = 0
        self._best_kf, self._best_score = None, -1.0
        self._session_id = None
        if duration < MIN_ACTIVITY_SESSION_SECONDS or frames < ACTIVITY_CONFIRM_FRAMES:
            return None
        return self._describe(activity, start, end, duration, confs, objects,
                              frames, best_kf, in_progress=False,
                              session_id=session_id)

    def _describe(self, activity, start, end, duration, confs, objects, frames,
                  best_kf, in_progress, session_id=None) -> dict[str, Any]:
        """One shape for an activity session, open or closed."""
        return {
            "activity": activity,
            "session_id": session_id or self._session_id,
            "in_progress": in_progress,
            "keyframe_id": best_kf,
            "started_at": SceneSessionTracker._fmt(start),
            "start_ts": start,
            "end_ts": end,
            "duration_seconds": round(duration),
            "observations": frames,
            "confidence": round(sum(confs) / len(confs), 3) if confs else 0.0,
            "objects": {k: round(v, 2) for k, v in sorted(
                objects.items(), key=lambda kv: -kv[1])[:8]},
            "label": describe_activity(activity, duration),
        }


ACTIVITY_TITLES = {
    "using a phone": "Using a phone",
    "using_phone": "Using a phone",
    "typing": "At a keyboard",
    "reading": "Reading",
    "eating": "Eating",
    "drinking": "Drinking",
    "cooking": "Cooking",
    "watching tv": "Watching television",
    "brushing teeth": "Brushing teeth",
    "washing hands": "Washing hands",
}


def describe_activity(activity: str, duration: float) -> str:
    """Human label for an activity session, without inventing detail."""
    key = str(activity).strip().lower().rstrip(".")
    return ACTIVITY_TITLES.get(key, key.capitalize() or "Activity")


def describe_session(room: str, start_ts: float, duration: float,
                     evidence: dict[str, float]) -> str:
    """Human label for a session, e.g. 'Lunch preparation'.

    Falls back to a plain scene title whenever the stronger claim is not
    justified, rather than inventing an activity the evidence does not support.
    """
    if room == "kitchen":
        hour = time.localtime(start_ts).tm_hour
        cooking = {"Pot", "Gas stove", "Induction Cooker", "Oven",
                   "Rice Cooker", "Cutting/chopping Board", "Kettle"}
        if cooking & evidence.keys():
            for lo, hi, name in MEAL_WINDOWS:
                if lo <= hour < hi:
                    return name
    return SCENE_TITLES.get(room, room.title())
