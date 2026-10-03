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
    """What was heard recently, for correlating with what was seen.

    This returned None from the day it was written, which is why FrameContext's
    transcript_segment was always empty. It now reads from the Transcriber that
    Module A FE-3 runs, and still returns None when there is no microphone, no
    transcriber, or nothing was said: silence is a normal answer here, not a
    failure.
    """

    def __init__(self, transcriber=None):
        self.transcriber = transcriber

    def get_recent_transcript_segment(self, window_seconds: int = 30) -> str | None:
        if self.transcriber is None:
            return None
        try:
            return self.transcriber.recent_text(window_seconds)
        except Exception:
            # Context is an enrichment. Losing it must never fail a detection.
            return None
