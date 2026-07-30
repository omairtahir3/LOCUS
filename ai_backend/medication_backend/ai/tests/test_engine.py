import unittest
import time
from ai_backend.medication_backend.ai.core.contracts import EventContext, FrameContext
from ai_backend.medication_backend.ai.core.engine import CoreAnalysisEngine, EventState
from ai_backend.medication_backend.ai.core.plugins import PluginRegistry
from ai_backend.medication_backend.ai.core.policy import ConfidencePolicy
from ai_backend.medication_backend.ai.core.privacy import PrivacyGate


class MockEventRepository:
    def save(self, record):
        pass


class MockPlugin:
    def __init__(self):
        self.model_name = "mock"
    
    def supports(self, context):
        return True
        
    def analyze(self, buffer, context):
        return None


class TestCoreAnalysisEngine(unittest.TestCase):
    def setUp(self):
        self.registry = PluginRegistry()
        self.registry.register(MockPlugin())
        self.policy = ConfidencePolicy()
        self.event_repo = MockEventRepository()
        self.privacy_gate = PrivacyGate()
        
        self.engine = CoreAnalysisEngine(
            registry=self.registry,
            policy=self.policy,
            event_repo=self.event_repo,
            privacy_gate=self.privacy_gate,
            pre_event_seconds=1,
            post_event_seconds=1,
            motion_threshold=5.0
        )

    def test_idle_to_collecting(self):
        self.assertEqual(self.engine.state, EventState.IDLE)
        
        context = FrameContext(user_id="user123")
        frame_data = {"id": "1", "motion_score": 10.0, "scene_changed": False}
        
        # This frame has motion, so it should transition IDLE -> POSSIBLE_EVENT -> COLLECTING
        self.engine.process_frame(frame_data, context)
        self.assertEqual(self.engine.state, EventState.COLLECTING)

    def test_privacy_gate_blocks_processing(self):
        self.privacy_gate = PrivacyGate()
        # Create a frame context with privacy_mode=True
        context = FrameContext(user_id="user123", privacy_mode=True)
        frame_data = {"id": "1", "motion_score": 10.0}
        
        events = self.engine.process_frame(frame_data, context)
        self.assertEqual(len(events), 0)
        self.assertEqual(self.engine.state, EventState.IDLE)


if __name__ == '__main__':
    unittest.main()
