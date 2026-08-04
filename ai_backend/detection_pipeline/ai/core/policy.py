"""Central confidence policy shared by every event detector."""

from __future__ import annotations

from dataclasses import dataclass

from .contracts import EventStatus


@dataclass(frozen=True)
class ConfidencePolicy:
    """Classify evidence using the product thresholds from Core Module FE-7."""

    auto_verify_threshold: float = 0.85
    confirmation_threshold: float = 0.70

    def __post_init__(self) -> None:
        if not 0.0 <= self.confirmation_threshold <= self.auto_verify_threshold <= 1.0:
            raise ValueError("confidence thresholds must satisfy 0 <= confirm <= auto <= 1")

    def status_for(self, confidence: float) -> EventStatus:
        if confidence >= self.auto_verify_threshold:
            return EventStatus.VERIFIED
        if confidence >= self.confirmation_threshold:
            return EventStatus.NEEDS_CONFIRMATION
        return EventStatus.DISCARDED

    def legacy_classification(self, confidence: float) -> dict[str, str | float]:
        """Preserve the existing medication API response fields while centralizing policy."""
        status = self.status_for(confidence)
        if status is EventStatus.VERIFIED:
            return {
                "classification": "auto_verified",
                "action": "log_automatically",
                "message": "Medication intake detected and automatically verified",
                "confidence": confidence,
            }
        if status is EventStatus.NEEDS_CONFIRMATION:
            return {
                "classification": "needs_confirmation",
                "action": "request_user_confirmation",
                "message": "Possible medication intake detected. Please confirm.",
                "confidence": confidence,
            }
        return {
            "classification": "missed",
            "action": "discard",
            "message": "Confidence below threshold — event discarded",
            "confidence": confidence,
        }
