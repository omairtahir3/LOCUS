"""Serializable data contracts shared by all current and future detectors."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4


class ActionType(StrEnum):
    MEDICATION_INTAKE = "medication_intake"
    ITEM_EXIT = "item_exit"
    FACE_INTERACTION = "face_interaction"
    ACTIVITY = "activity"


class EventStatus(StrEnum):
    VERIFIED = "verified"
    NEEDS_CONFIRMATION = "needs_confirmation"
    DISCARDED = "discarded"


@dataclass(frozen=True)
class ModelReference:
    """Identifies the model that produced an event without exposing model internals."""

    name: str
    version: str = "unknown"


@dataclass(frozen=True)
class EventContext:
    """Optional context supplied by capture, location, audio, and schedule modules."""

    user_id: str = ""
    timestamp: str = ""
    environment: str = "unknown"
    gps: dict[str, Any] | None = None
    transcript_id: str | None = None
    privacy_mode: bool = False
    active_medication_context: dict[str, Any] | None = None
    medication_ids: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class FrameContext:
    """Enriched per-frame context."""
    user_id: str
    timestamp: str
    environment: str = "unknown"
    gps: dict[str, Any] | None = None
    transcript_segment: str | None = None
    privacy_mode: bool = False
    active_medication_context: dict[str, Any] | None = None


@dataclass(frozen=True)
class DetectionResult:
    """Normalized output from a detector plugin before policy is applied."""

    action_type: ActionType
    confidence: float
    evidence_keyframe_ids: list[str] = field(default_factory=list)
    attributes: dict[str, Any] = field(default_factory=dict)
    model: ModelReference = field(default_factory=lambda: ModelReference("unknown"))


@dataclass(frozen=True)
class EventRecord:
    """Portable, JSON-safe event record for local storage now and cloud upload later."""

    event_id: str
    user_id: str
    action_type: ActionType
    status: EventStatus
    confidence: float
    timestamp: str
    keyframe_ids: list[str]
    model: ModelReference
    environment: str = "unknown"
    gps: dict[str, Any] | None = None
    transcript_id: str | None = None
    attributes: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_detection(
        cls,
        detection: DetectionResult,
        context: EventContext,
        status: EventStatus,
    ) -> "EventRecord":
        return cls(
            event_id=str(uuid4()),
            user_id=context.user_id,
            action_type=detection.action_type,
            status=status,
            confidence=round(float(detection.confidence), 3),
            timestamp=context.timestamp or datetime.now(timezone.utc).isoformat(),
            keyframe_ids=list(detection.evidence_keyframe_ids),
            model=detection.model,
            environment=context.environment,
            gps=context.gps,
            transcript_id=context.transcript_id,
            attributes=dict(detection.attributes),
        )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
