"""Core event-based processing engine."""

from __future__ import annotations

import time
from collections import deque
from enum import StrEnum

from .contracts import EventContext, EventRecord, FrameContext
from .plugins import PluginRegistry
from .policy import ConfidencePolicy
from .privacy import PrivacyGate
from .repositories import EventRepository


class EventState(StrEnum):
    IDLE = "idle"
    POSSIBLE_EVENT = "possible_event"    # motion/scene triggered
    COLLECTING = "collecting"             # capturing pre + active frames
    POST_EVENT = "post_event"             # waiting for post-event cooldown
    ANALYZING = "analyzing"               # running plugins


class CoreAnalysisEngine:
    def __init__(
        self,
        registry: PluginRegistry,
        policy: ConfidencePolicy,
        event_repo: EventRepository,
        privacy_gate: PrivacyGate,
        pre_event_seconds: int = 3,
        post_event_seconds: int = 3,
        motion_threshold: float = 10.0,
        capture_fps: float = 5.0,
    ) -> None:
        self.registry = registry
        self.policy = policy
        self.event_repo = event_repo
        self.privacy_gate = privacy_gate
        
        self.pre_event_seconds = pre_event_seconds
        self.post_event_seconds = post_event_seconds
        self.motion_threshold = motion_threshold
        self.capture_fps = capture_fps

        self.state = EventState.IDLE
        # FE-3: 3 s before the trigger plus 3 s after it, a 6 s event window
        # inside the 5-10 s the spec asks for. Sized from the real capture
        # ceiling (FE-1 is 5 FPS); this used to hardcode 10 FPS and so held
        # twice the intended span.
        self.pre_event_buffer = deque(maxlen=int(pre_event_seconds * capture_fps))
        self.active_buffer = []
        
        self.last_motion_time = 0.0
        self.event_start_time = 0.0
        self.session_context = None

    def process_frame(self, frame_data: dict, context: FrameContext) -> list[EventRecord]:
        """Process a single frame and potentially return detected events."""
        if not self.privacy_gate.should_process(context):
            return []
            
        self.session_context = context
        
        motion_score = frame_data.get("motion_score", 0.0)
        scene_changed = frame_data.get("scene_changed", False)
        
        # Add to pre-event buffer always
        self.pre_event_buffer.append(frame_data)
        
        self._transition_state(motion_score, scene_changed)
        
        if self.state in (EventState.COLLECTING, EventState.POST_EVENT):
            # We don't want duplicates if it's already in the active buffer
            if not self.active_buffer or self.active_buffer[-1]["id"] != frame_data["id"]:
                self.active_buffer.append(frame_data)
                
        if self.state == EventState.ANALYZING:
            events = self._run_plugins(context)
            self._reset_state()
            return events
            
        return []

    def _transition_state(self, motion_score: float, scene_changed: bool) -> None:
        now = time.time()
        has_motion = motion_score > self.motion_threshold or scene_changed
        
        if has_motion:
            self.last_motion_time = now
            
        if self.state == EventState.IDLE:
            if has_motion:
                self.state = EventState.POSSIBLE_EVENT
                self.event_start_time = now
                
        elif self.state == EventState.POSSIBLE_EVENT:
            # Move immediately to collecting
            self.state = EventState.COLLECTING
            self.active_buffer = list(self.pre_event_buffer)
            
        elif self.state == EventState.COLLECTING:
            if not has_motion and (now - self.last_motion_time) > self.post_event_seconds:
                self.state = EventState.POST_EVENT
                
        elif self.state == EventState.POST_EVENT:
            # We've waited the cooldown period, time to analyze
            self.state = EventState.ANALYZING

    def _run_plugins(self, frame_context: FrameContext) -> list[EventRecord]:
        event_context = EventContext(
            user_id=frame_context.user_id,
            timestamp=frame_context.timestamp,
            environment=frame_context.environment,
            gps=frame_context.gps,
            transcript_id=frame_context.transcript_segment,
            medication_ids=frame_context.active_medication_context.get("medication_ids", []) if frame_context.active_medication_context else [],
        )
        
        detected_events = []
        for plugin in self.registry.applicable(event_context):
            try:
                detection = plugin.analyze(self.active_buffer, event_context)
                if detection:
                    status = self.policy.status_for(detection.confidence)
                    record = EventRecord.from_detection(detection, event_context, status)
                    detected_events.append(record)
            except Exception as e:
                print(f"[CoreAnalysisEngine] Error in plugin {plugin.model_name}: {e}")
                
        return detected_events
        
    def _reset_state(self) -> None:
        self.state = EventState.IDLE
        self.active_buffer = []
        self.event_start_time = 0.0
