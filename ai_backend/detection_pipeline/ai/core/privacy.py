"""Privacy and geofence gate to filter frames before analysis."""

from __future__ import annotations

from .contracts import FrameContext


class PrivacyGate:
    def __init__(self, sensitive_locations: list[dict] = None) -> None:
        self.sensitive_locations = sensitive_locations or []

    def should_process(self, context: FrameContext) -> bool:
        """Return True if the frame is allowed to be processed."""
        if context.privacy_mode:
            return False
            
        if context.gps and self._in_sensitive_geofence(context.gps):
            return False
            
        return True
        
    def _in_sensitive_geofence(self, gps: dict) -> bool:
        """Stub for geofence checking. In the future this will use the location backend."""
        # TODO: Implement geofence distance calculation using haversine or similar
        return False
