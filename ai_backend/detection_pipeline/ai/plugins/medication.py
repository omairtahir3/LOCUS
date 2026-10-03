"""Medication intake plugin using YOLOv8 and MediaPipe."""

from __future__ import annotations

import time

from ..core.contracts import ActionType, DetectionResult, EventContext, ModelReference
from ..core.plugins import DetectorPlugin


class MedicationIntakePlugin(DetectorPlugin):
    """Detects medication intake sequence using YOLO object detection and MediaPipe hand tracking."""

    action_type = ActionType.MEDICATION_INTAKE
    model_name = "pill-detector-plus-mediapipe"

    def __init__(self, model_path: str = "ai/best_model.onnx") -> None:
        self.model_path = model_path
        self._detector = None
        self._gesture = None
        self._objects = None

    def _ensure_models_loaded(self) -> None:
        if self._detector is None:
            from ..detector import PillDetector
            self._detector = PillDetector(model_path=self.model_path)
        if self._gesture is None:
            from ..gesture import GestureDetector
            self._gesture = GestureDetector()

    # Objects365 classes that have a lit screen on them. A round pale shape on
    # one of these is part of the display, not something anybody swallows.
    _SCREEN_CLASSES = {37: "Monitor/TV", 61: "Cell Phone", 73: "Laptop",
                       123: "Telephone", 243: "Tablet"}

    def _screen_boxes(self, frame):
        """Screens in this frame, as (name, bbox) pairs.

        Loaded lazily and shared with the item indexer's weights, and only ever
        called on a frame that has ALREADY produced a pill-in-hand candidate, so
        a session where nobody takes anything never runs it at all.
        """
        try:
            if self._objects is None:
                from ultralytics import YOLO
                from ..item_indexer import DEFAULT_MODEL_PATH
                self._objects = YOLO(DEFAULT_MODEL_PATH)
            r = self._objects.predict(frame, conf=0.25, verbose=False)[0]
            out = []
            for box in r.boxes:
                cid = int(box.cls[0])
                if cid in self._SCREEN_CLASSES:
                    x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
                    out.append((self._SCREEN_CLASSES[cid],
                                {"x1": x1, "y1": y1, "x2": x2, "y2": y2}))
            return out
        except Exception as e:
            # No veto is better than no detection: an object model that fails to
            # load must not stop a real intake being recorded.
            print(f"[MedicationIntakePlugin] screen check unavailable: {e}")
            return []

    @staticmethod
    def _within(inner, outer, slack=0.10):
        w = outer["x2"] - outer["x1"]
        h = outer["y2"] - outer["y1"]
        return (inner["x1"] >= outer["x1"] - w * slack
                and inner["y1"] >= outer["y1"] - h * slack
                and inner["x2"] <= outer["x2"] + w * slack
                and inner["y2"] <= outer["y2"] + h * slack)

    def _drop_screen_artifacts(self, frame, detections):
        """Remove pill candidates that are really part of a screen.

        A phone held in both hands put a round pale record button under the
        detector at 0.96 confidence, and the hand check passed it because the
        phone genuinely was in the hands. Every test of "is this a pill" was
        satisfied; the thing simply was not one. Nothing about the candidate
        itself distinguishes it, so the surrounding object has to.
        """
        if not detections:
            return detections, None
        screens = self._screen_boxes(frame)
        if not screens:
            return detections, None
        kept, blamed = [], None
        for d in detections:
            hit = next((n for n, box in screens if self._within(d["bbox"], box)), None)
            if hit:
                blamed = hit
            else:
                kept.append(d)
        return kept, blamed

    def supports(self, context: EventContext) -> bool:
        return bool(context.medication_ids)

    def analyze(self, event_buffer: list[dict], context: EventContext) -> DetectionResult | None:
        if not event_buffer or len(event_buffer) < 3:
            return None

        self._ensure_models_loaded()

        valid_frames = []
        for kf in event_buffer:
            # `or` would force a truth test on the array itself, which numpy
            # rejects for multi-element arrays — check for None explicitly.
            raw = kf.get("raw_frame")
            if raw is None:
                raw = kf.get("frame")
            if raw is not None:
                valid_frames.append({
                    "frame": raw,
                    "timestamp": kf.get("timestamp", ""),
                    "id": kf.get("id", ""),
                    "kf": kf
                })

        if len(valid_frames) < 3:
            return None

        # 1. Batch detection
        batch_results = self._detector.detect_batch(valid_frames)

        # 2. Frame-level analysis
        analyzed = []
        for fi, (vf, det_result) in enumerate(zip(valid_frames, batch_results)):
            raw = vf["frame"]
            detections = det_result["detections"]
            
            try:
                gesture = self._gesture.analyze_frame(raw)
                hands = gesture["hands_detected"]
                best_pill = max((d["confidence"] for d in detections), default=0.0)
                
                pih = False
                overlap = 0.0
                in_hand_count = 0
                if detections and hands > 0:
                    pih, overlap, in_hand_count = self._is_pill_in_hand(detections, gesture)
                    # Only once something looks like a pill in a hand is it worth
                    # asking what the hand is actually holding. A phone is in the
                    # hands exactly as a pill would be, so the hand test cannot
                    # tell them apart and the object around the candidate must.
                    if pih:
                        detections, screen = self._drop_screen_artifacts(raw, detections)
                        if screen is not None:
                            best_pill = max((d["confidence"] for d in detections), default=0.0)
                            if detections:
                                pih, overlap, in_hand_count = self._is_pill_in_hand(detections, gesture)
                            else:
                                pih, overlap, in_hand_count = False, 0.0, 0
                            print(f"[MedicationIntakePlugin] Ignored a pill candidate on a "
                                  f"{screen}; it is part of the display, not a dose")

                hand_y = 1.0
                hbox = gesture.get("hand_bbox")
                if hbox:
                    hand_y = ((hbox["y1"] + hbox["y2"]) / 2.0) / raw.shape[0]

                analyzed.append({
                    "kf": vf["kf"], "frame": raw, "detections": detections,
                    "gesture": gesture, "best_pill": best_pill,
                    "pill_in_hand": pih, "overlap": overlap,
                    "in_hand_count": in_hand_count, "hands": hands,
                    "hand_y": hand_y, "motion": gesture.get("upward_motion_score", 0),
                    "near_top": gesture.get("hand_near_top", False),
                    "near_top_score": gesture.get("hand_near_top_score", 0),
                    "id": vf["id"]
                })
            except Exception as e:
                print(f"[MedicationIntakePlugin] Frame error: {e}")

        # 3. Phase Analysis
        any_pill_in_hand = any(a["pill_in_hand"] and a["best_pill"] >= 0.45 and a["hands"] > 0 for a in analyzed)
        if not any_pill_in_hand:
            return None

        p1_idx, p1_data = None, None
        best_p1_pill = -1.0
        p1_search_end = min(len(analyzed), int(len(analyzed) * 0.7)) or len(analyzed)
        
        for i in range(p1_search_end):
            a = analyzed[i]
            if a["pill_in_hand"] and a["best_pill"] >= 0.45 and a["hands"] > 0:
                if a["best_pill"] > best_p1_pill:
                    best_p1_pill = a["best_pill"]
                    p1_idx, p1_data = i, a

        if p1_data is None:
            return None

        p2_idx, p2_data = None, None
        best_p2_composite = -1.0
        for i in range(p1_idx + 1, len(analyzed)):
            a = analyzed[i]
            # Must have hand and upward motion
            if a["hands"] > 0 and (a["motion"] > 0.25 or a["near_top"]):
                comp = (1.0 - a["hand_y"]) * 2.0 + a["motion"] + a["near_top_score"]
                if comp > best_p2_composite:
                    best_p2_composite = comp
                    p2_idx, p2_data = i, a

        if p2_data is None:
            return None

        p3_idx, p3_data = None, None
        best_p3_score = -1.0
        for i in range(p2_idx + 1, len(analyzed)):
            a = analyzed[i]
            # Hand should be lower or moving down, pill gone
            is_pill_gone = (not a["pill_in_hand"] and a["best_pill"] < 0.30)
            if is_pill_gone:
                score = a["hand_y"] + (1.0 - a["best_pill"])
                if score > best_p3_score:
                    best_p3_score = score
                    p3_idx, p3_data = i, a

        if p3_data is None:
            return None

        # 4. Compute confidence
        confidence = self._compute_temporal_confidence([p1_data, p2_data, p3_data])
        
        evidence_ids = [p1_data["id"], p2_data["id"], p3_data["id"]]
        
        return DetectionResult(
            action_type=self.action_type,
            confidence=confidence,
            evidence_keyframe_ids=evidence_ids,
            attributes={
                "medication_ids": list(context.medication_ids),
                "phases_passed": 3,
                "pill_count": p1_data["in_hand_count"],
            },
            model=ModelReference(self.model_name, "plugin_v1"),
        )

    def _is_pill_in_hand(self, detections, gesture_result, overlap_threshold=0.15):
        hand_bboxes = gesture_result.get("all_hand_bboxes", [])
        all_fingertips = gesture_result.get("all_fingertips", [])
        all_palm_centers = gesture_result.get("all_palm_centers", [])
        
        if not hand_bboxes or not detections:
            return False, 0.0, 0

        best_overlap = 0.0
        in_hand_count = 0

        for det in detections:
            if det["confidence"] < 0.40:
                continue

            pill_bbox = det["bbox"]
            pill_w = pill_bbox["x2"] - pill_bbox["x1"]
            pill_h = pill_bbox["y2"] - pill_bbox["y1"]
            pill_cx = (pill_bbox["x1"] + pill_bbox["x2"]) / 2
            pill_cy = (pill_bbox["y1"] + pill_bbox["y2"]) / 2

            for hand_idx, hand_bbox in enumerate(hand_bboxes):
                overlap = self._bbox_overlap(pill_bbox, hand_bbox)
                if overlap < overlap_threshold:
                    continue

                hand_w = hand_bbox["x2"] - hand_bbox["x1"]
                hand_h = hand_bbox["y2"] - hand_bbox["y1"]
                if (pill_w * pill_h) / max(1, hand_w * hand_h) > 0.35:
                    continue

                if hand_idx < len(all_palm_centers):
                    palm = all_palm_centers[hand_idx]
                    dist = ((pill_cx - palm["x"])**2 + (pill_cy - palm["y"])**2)**0.5
                    if dist > ((hand_w**2 + hand_h**2)**0.5) * 0.8:
                        continue

                is_at_fingertip = False
                if hand_idx < len(all_fingertips) and hand_idx < len(all_palm_centers):
                    tips = all_fingertips[hand_idx]
                    palm = all_palm_centers[hand_idx]
                    palm_dist = ((pill_cx - palm["x"])**2 + (pill_cy - palm["y"])**2)**0.5
                    
                    for tip in tips:
                        tip_dist = ((pill_cx - tip["x"])**2 + (pill_cy - tip["y"])**2)**0.5
                        if tip_dist < 45 and tip_dist < palm_dist:
                            is_at_fingertip = True
                            break
                            
                if is_at_fingertip:
                    continue

                best_overlap = max(best_overlap, overlap)
                in_hand_count += 1
                break

        return in_hand_count > 0, best_overlap, in_hand_count

    @staticmethod
    def _bbox_overlap(box_a, box_b):
        x1 = max(box_a["x1"], box_b["x1"])
        y1 = max(box_a["y1"], box_b["y1"])
        x2 = min(box_a["x2"], box_b["x2"])
        y2 = min(box_a["y2"], box_b["y2"])
        if x2 <= x1 or y2 <= y1:
            return 0.0
        intersection = (x2 - x1) * (y2 - y1)
        area_a = max(1, (box_a["x2"] - box_a["x1"]) * (box_a["y2"] - box_a["y1"]))
        area_b = max(1, (box_b["x2"] - box_b["x1"]) * (box_b["y2"] - box_b["y1"]))
        return intersection / min(area_a, area_b)

    def _compute_temporal_confidence(self, phase_data):
        if not all(phase_data):
            return 0.0
        
        p1, p2, p3 = phase_data
        
        c1 = (p1["best_pill"] * 0.5) + (min(1.0, p1["overlap"] * 3.0) * 0.5)
        c2 = min(1.0, p2["motion"] * 0.5 + p2["near_top_score"] * 0.5)
        c3 = (1.0 - p3["best_pill"])
        
        base_confidence = (c1 * 0.4) + (c2 * 0.4) + (c3 * 0.2)
        confidence = min(0.95, base_confidence)
        
        return round(float(confidence), 3)

    def from_pipeline_result(self, result: dict, context: EventContext, evidence_frames: list[dict] | None = None) -> DetectionResult:
        # Legacy adapter for pipeline.py - remains unchanged
        phase_details = result.get("phase_details", {})
        evidence_ids = [
            frame_id
            for frame_id in (
                phase_details.get("phase1_medicine_visible", {}).get("keyframe_id"),
                phase_details.get("phase2_grip_and_motion", {}).get("keyframe_id"),
                phase_details.get("phase3_medicine_gone", {}).get("keyframe_id"),
            )
            if frame_id
        ]
        if evidence_frames:
            evidence_ids.extend(frame["id"] for frame in evidence_frames if frame.get("id"))

        return DetectionResult(
            action_type=self.action_type,
            confidence=float(result.get("final_confidence", 0.0)),
            evidence_keyframe_ids=list(dict.fromkeys(evidence_ids)),
            attributes={
                "medication_ids": list(context.medication_ids),
                "phases_passed": phase_details.get("phases_passed", 0),
                "phase_details": phase_details,
                "pill_count": result.get("_in_hand_count", 0),
            },
            model=ModelReference(self.model_name, "existing"),
        )
