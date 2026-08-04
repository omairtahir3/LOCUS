"""Shared contracts for event-based video analysis plugins."""

from .contracts import (
    ActionType,
    DetectionResult,
    EventContext,
    FrameContext,
    EventRecord,
    EventStatus,
    ModelReference,
)
from .plugins import DetectorPlugin, PluginRegistry
from .policy import ConfidencePolicy
from .repositories import EventRepository, VerificationJobRepository

__all__ = [
    "ActionType",
    "ConfidencePolicy",
    "DetectionResult",
    "DetectorPlugin",
    "EventContext",
    "FrameContext",
    "EventRecord",
    "EventStatus",
    "EventRepository",
    "ModelReference",
    "PluginRegistry",
    "VerificationJobRepository",
]
