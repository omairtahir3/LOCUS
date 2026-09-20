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

import time
from collections import defaultdict
from typing import Any, Optional

# Objects365 class name -> how strongly it implies the room.
# 1.0 = defining (this object essentially only exists in that room)
# 0.5-0.8 = supporting
# Anything that appears across rooms is deliberately absent, not down-weighted.
SCENE_WEIGHTS: dict[str, dict[str, float]] = {
    "kitchen": {
        "Refrigerator": 1.0, "Microwave": 1.0, "Oven": 1.0, "Gas stove": 1.0,
        "Induction Cooker": 1.0, "Rice Cooker": 1.0, "Dishwasher": 1.0,
        "Extractor": 1.0, "Coffee Machine": 0.9, "Blender": 0.8,
        "Pot": 0.7, "Kettle": 0.7, "Cutting/chopping Board": 0.7,
        "Cabinet/shelf": 0.5,
    },
    "bedroom": {
        "Bed": 1.0, "Pillow": 0.9, "Nightstand": 0.9, "Wardrobe": 0.8,
        "Lamp": 0.4, "Mirror": 0.3,
    },
    "living": {
        "Couch": 1.0, "Monitor/TV": 0.8, "Coffee Table": 0.8,
        "Remote": 0.6, "Picture/Frame": 0.3, "Candle": 0.3,
    },
    "bathroom": {
        "Toilet": 1.0, "Bathtub": 1.0, "Sink": 0.8, "Towel": 0.8,
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
}

DEFINING_OBJECTS: dict[str, set[str]] = {
    room: {cls for cls, w in weights.items() if w >= 0.8}
    for room, weights in SCENE_WEIGHTS.items()
}

MIN_SCENE_SCORE = 0.35     # below this, no room is claimed
MIN_SCENE_MARGIN = 0.15    # winner must beat the runner-up by this much

# A scene must hold for this many consecutive classified keyframes before the
# session switches. Without hysteresis the label flaps on a single stray
# detection, which is the failure this module exists to avoid. Frames that
# classify as unknown do not break a session -- the wearer looking down at their
# lap is not a change of room.
SCENE_SWITCH_FRAMES = 2

# How long a session may coast on unknown frames before it is closed at its last
# confirmed sighting. Unknown frames must extend a session -- the wearer looking
# down at their lap is not a change of room -- but extending it indefinitely is
# wrong: a bedroom sighting at 03:16 followed by 19 minutes of unrecognised
# frames produced a single "bedroom, 19 min" session covering a stretch the
# wearer had long since walked out of. Beyond this gap we have simply lost
# track, and the honest end of the session is the last time we actually saw the
# room.
SCENE_STALE_SECONDS = 180

# A session shorter than this is noise (walking through a room), not an event.
# 10s, because keyframes arrive roughly every 14 seconds: a session is measured
# from its first sighting to its last CONFIRMED sighting, so a genuine two-frame
# visit spans only ~14s and a 30s floor silently discarded a real trip to the
# kitchen. The defining-object rule keeps precision high (0 wrong across the
# 22-frame calibration set), so short sessions here are real visits rather than
# noise, and dropping them loses information a memory aid actually wants.
MIN_SESSION_SECONDS = 10


def classify_scene(detections: dict[str, float]) -> tuple[Optional[str], float, dict[str, float]]:
    """Classify one frame's room from {objects365_class_name: confidence}.

    Returns (room or None, winning score, all room scores).
    """
    scores: dict[str, float] = {}
    for room, weights in SCENE_WEIGHTS.items():
        if not (DEFINING_OBJECTS[room] & detections.keys()):
            scores[room] = 0.0
            continue
        scores[room] = sum(w * detections[cls] for cls, w in weights.items() if cls in detections)

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

    def observe(self, room: Optional[str], detections: dict[str, float],
                timestamp: Optional[float] = None) -> Optional[dict[str, Any]]:
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
            return None

        # A different room — require it to persist before switching.
        if room == self._pending:
            self._pending_count += 1
        else:
            self._pending = room
            self._pending_count = 1
            self._pending_since = ts
        if self._pending_count < SCENE_SWITCH_FRAMES:
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
        self._last_seen = ts
        self._last_confirmed = ts
        self._frames = 1
        self._evidence = defaultdict(float)
        for cls, conf in detections.items():
            self._evidence[cls] = max(self._evidence[cls], conf)
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
        self._current = None
        self._started_at = None
        self._last_seen = None
        self._last_confirmed = None
        self._evidence = defaultdict(float)
        self._frames = 0
        if duration < MIN_SESSION_SECONDS:
            return None
        return {
            "scene": room,
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
