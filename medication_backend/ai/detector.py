import onnxruntime as ort
import numpy as np
import cv2
import os


# Classes this model detects
PILL_CLASSES = {
    0: "tablet",
    1: "capsule",
}

PILL_CONFIDENCE_THRESHOLD = 0.45


class PillDetector:
    """
    Pill detector using the pre-trained YOLOv8 ONNX model from:
    https://github.com/seblful/pills-detection
    
    Trained specifically on tablets and capsules — 93.1% mAP accuracy.
    Works for loose tablets, blister packs, pill organizers — no bottle needed.
    """

    def __init__(self, model_path="ai/best_model.onnx"):
        if not os.path.exists(model_path):
            raise FileNotFoundError(
                f"Pill detection model not found at: {model_path}\n"
                f"Download best_model.onnx from:\n"
                f"https://github.com/seblful/pills-detection/blob/main/best_model.onnx\n"
                f"and place it in LOCUS/medication_backend/ai/"
            )

        print(f"Loading pill detection model: {model_path}")
        self.session = ort.InferenceSession(
            model_path,
            providers=["CPUExecutionProvider"]
        )
        self.input_name  = self.session.get_inputs()[0].name
        self.input_shape = self.session.get_inputs()[0].shape
        self.img_size    = self.input_shape[2]
        print(f"Pill detection model loaded. Input shape: {self.input_shape}")

    def preprocess(self, frame):
        """Resize and normalize frame for model input. Pads to batch size 8."""
        img = cv2.resize(frame, (self.img_size, self.img_size))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = img.astype(np.float32) / 255.0
        img = np.transpose(img, (2, 0, 1))  # (3, 640, 640)

        # Model expects fixed batch size of 8 — pad with zeros
        batch = np.zeros((8, 3, self.img_size, self.img_size), dtype=np.float32)
        batch[0] = img
        return batch

    def postprocess(self, outputs, orig_h, orig_w, conf_threshold=PILL_CONFIDENCE_THRESHOLD):
        """Parse raw ONNX output into detection list."""
        output = outputs[0][0]
        output = np.transpose(output)

        detections = []
        for row in output:
            x_center, y_center, width, height = row[0], row[1], row[2], row[3]
            class_scores = row[4:]
            class_id = int(np.argmax(class_scores))
            confidence = float(class_scores[class_id])

            if confidence < conf_threshold:
                continue

            x1 = int((x_center - width / 2) / self.img_size * orig_w)
            y1 = int((y_center - height / 2) / self.img_size * orig_h)
            x2 = int((x_center + width / 2) / self.img_size * orig_w)
            y2 = int((y_center + height / 2) / self.img_size * orig_h)

            x1 = max(0, x1); y1 = max(0, y1)
            x2 = min(orig_w, x2); y2 = min(orig_h, y2)

            detections.append({
                "class":      PILL_CLASSES.get(class_id, f"class_{class_id}"),
                "class_id":   class_id,
                "confidence": round(confidence, 3),
                "bbox":       {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "center":     {"x": (x1 + x2) // 2, "y": (y1 + y2) // 2}
            })

        return self._apply_nms(detections)

    def _apply_nms(self, detections, iou_threshold=0.45):
        """Remove overlapping duplicate detections."""
        if not detections:
            return []

        boxes  = np.array([[d["bbox"]["x1"], d["bbox"]["y1"], d["bbox"]["x2"], d["bbox"]["y2"]] for d in detections])
        scores = np.array([d["confidence"] for d in detections])

        indices = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), PILL_CONFIDENCE_THRESHOLD, iou_threshold)

        if len(indices) == 0:
            return []

        return [detections[i] for i in indices.flatten()]

    def detect(self, frame):
        """Run pill detection on a single frame."""
        orig_h, orig_w = frame.shape[:2]
        input_tensor = self.preprocess(frame)
        outputs = self.session.run(None, {self.input_name: input_tensor})
        return self.postprocess(outputs, orig_h, orig_w)

    def detect_batch(self, frames):
        """Run detection across temporal buffer frames."""
        results = []
        for frame_data in frames:
            detections = self.detect(frame_data["frame"])
            results.append({
                "timestamp":  frame_data["timestamp"],
                "frame_id":   frame_data["id"],
                "detections": detections,
                "pill_count": len(detections)
            })
        return results

    def compute_pill_scene_score(self, batch_detections):
        """
        Score medication scene across temporal buffer.
        Pills must be consistently visible across frames for high confidence.
        """
        if not batch_detections:
            return 0.0

        frame_scores = []
        for frame_result in batch_detections:
            if not frame_result["detections"]:
                frame_scores.append(0.0)
                continue

            best_conf = max(d["confidence"] for d in frame_result["detections"])
            pill_count_bonus = min(0.1, (frame_result["pill_count"] - 1) * 0.03)
            frame_scores.append(min(1.0, best_conf + pill_count_bonus))

        frames_with_pills = sum(1 for s in frame_scores if s > 0)
        consistency_ratio = frames_with_pills / len(frame_scores)
        avg_score = np.mean(frame_scores)

        return round(float(avg_score * consistency_ratio), 3)

    def annotate_frame(self, frame, detections):
        """Draw bounding boxes for debugging."""
        annotated = frame.copy()
        for det in detections:
            bbox  = det["bbox"]
            label = f"{det['class']} {det['confidence']:.2f}"
            color = (0, 212, 184)
            cv2.rectangle(annotated, (bbox["x1"], bbox["y1"]), (bbox["x2"], bbox["y2"]), color, 2)
            cv2.putText(annotated, label, (bbox["x1"], bbox["y1"] - 8),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)
        cv2.putText(annotated, f"Pills: {len(detections)}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 212, 184), 2)
        return annotated