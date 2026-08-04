"""Context providers for event analysis."""

from __future__ import annotations


class EnvironmentClassifier:
    """Classifies the environment from an image frame."""
    
    def classify(self, frame) -> str:
        """Stub for future ML environment classification.
        Returns strings like 'kitchen', 'doorway', 'bedroom'.
        """
        # TODO: Implement CLIP or similar for zero-shot scene classification
        return "unknown"


class LocationProvider:
    """Provides GPS location context."""
    
    def get_current_location(self) -> dict:
        """Stub for GPS provider."""
        return {"lat": 0.0, "lng": 0.0}


class AudioContext:
    """Provides audio context for event correlation."""
    
    def get_recent_transcript_segment(self, window_seconds: int = 30) -> str | None:
        """Stub for audio/transcript lookup."""
        return None
