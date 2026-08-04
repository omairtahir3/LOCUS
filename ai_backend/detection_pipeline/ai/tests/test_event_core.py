import json
import unittest

from ai_backend.detection_pipeline.ai.core import (
    ActionType,
    ConfidencePolicy,
    EventContext,
    EventRecord,
    EventStatus,
    ModelReference,
    PluginRegistry,
)
from ai_backend.detection_pipeline.ai.core.contracts import DetectionResult
from ai_backend.detection_pipeline.ai.plugins import MODEL_PLUGIN_CATALOG, MedicationIntakePlugin


class EventCoreTests(unittest.TestCase):
    def test_fe7_confidence_boundaries(self):
        policy = ConfidencePolicy()
        self.assertEqual(policy.status_for(0.85), EventStatus.VERIFIED)
        self.assertEqual(policy.status_for(0.849), EventStatus.NEEDS_CONFIRMATION)
        self.assertEqual(policy.status_for(0.70), EventStatus.NEEDS_CONFIRMATION)
        self.assertEqual(policy.status_for(0.699), EventStatus.DISCARDED)
        self.assertEqual(policy.legacy_classification(0.20)["action"], "discard")

    def test_event_record_is_json_serializable(self):
        detection = DetectionResult(
            action_type=ActionType.MEDICATION_INTAKE,
            confidence=0.91,
            evidence_keyframe_ids=["phase-1", "phase-2"],
            attributes={"pill_count": 2},
            model=ModelReference("pill-detector-plus-mediapipe", "existing"),
        )
        event = EventRecord.from_detection(
            detection,
            EventContext(user_id="user-1", medication_ids=["med-1"]),
            EventStatus.VERIFIED,
        ).to_dict()
        self.assertEqual(event["action_type"], "medication_intake")
        self.assertEqual(event["status"], "verified")
        self.assertEqual(json.loads(json.dumps(event))["keyframe_ids"], ["phase-1", "phase-2"])

    def test_medication_adapter_preserves_phase_evidence(self):
        plugin = MedicationIntakePlugin()
        raw_result = {
            "final_confidence": 0.9,
            "_in_hand_count": 2,
            "phase_details": {
                "phases_passed": 3,
                "phase1_medicine_visible": {"keyframe_id": "p1"},
                "phase2_grip_and_motion": {"keyframe_id": "p2"},
                "phase3_medicine_gone": {"keyframe_id": "p3"},
            },
        }
        result = plugin.from_pipeline_result(
            raw_result,
            EventContext(user_id="user-1", medication_ids=["med-1"]),
            [{"id": "p1"}, {"id": "p2"}, {"id": "p3"}],
        )
        self.assertEqual(result.evidence_keyframe_ids, ["p1", "p2", "p3"])
        self.assertEqual(result.attributes["pill_count"], 2)

    def test_registry_and_four_domain_catalog(self):
        registry = PluginRegistry()
        medication = MedicationIntakePlugin()
        registry.register(medication)
        self.assertIs(registry.get(ActionType.MEDICATION_INTAKE), medication)
        self.assertEqual({spec.action_type for spec in MODEL_PLUGIN_CATALOG}, set(ActionType))


if __name__ == "__main__":
    unittest.main()
