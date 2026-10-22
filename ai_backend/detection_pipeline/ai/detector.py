import onnxruntime as ort
import numpy as np
import cv2
import os


# Classes this model detects
PILL_CLASSES = {
    0: "tablet",
    1: "capsule",
}

PILL_CONFIDENCE_THRESHOLD = 0.20

# ── How big a pill can possibly be, as a fraction of frame width ──────────
#
# The model finds round pale discs and has no idea how far away they are. In
# one wearer's bedroom it labelled the WALL CLOCK a pill at 0.770 and the
# FAN's circular dial at 0.778, in the same frame, while they were lifting a
# laptop with both hands. That frame was then filed as medication evidence
# needing confirmation.
#
# Every guard downstream is RELATIVE -- overlap with a hand, size against that
# hand, distance from the palm -- and relative tests cannot see depth. A clock
# three metres away is small next to a hand held close, in the flat projection
# the camera gives us. The same mistake, in the same codebase, once read a
# phone on a bed as a phone in a hand.
#
# So an absolute ceiling, derived from physical size rather than fitted to
# these two false positives. A 500mg tablet is about 13mm across. The camera
# is 1280px wide with roughly a 70 degree horizontal field, so at 50cm it
# spans about 70cm of the world: a tablet is then around 24px, and about 40px
# at arm's length of 30cm. 5% of frame width is 64px, which is comfortably
# past any way a hand can hold a tablet up to a chest camera, and well under
# the clock (71px) and the fan dial (108px).
#
# NOT validated against a confirmed pill detection: there is no true-positive
# evidence frame in this installation to check it against. It is derived, not
# measured, and the first real dose taken on camera is what will confirm it.
MAX_PILL_FRAC = float(os.environ.get("MAX_PILL_FRAC", 0.05))


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
                f"and place it in LOCUS/ai_backend/detection_pipeline/ai/"
            )

        print(f"Loading pill detection model: {model_path}")
        # One core fewer than the machine has, deliberately.
        #
        # This runs in 60-frame batches costing ~87 s of CPU, and ONNX Runtime
        # takes every core by default. The item indexer shares the machine, and
        # measured against that default its tile scan went from 4.6 s between
        # batches to 24.6 s and 34.6 s during one -- five to seven times slower,
        # for about three quarters of a medication window, which is what the
        # wearer experienced as items being logged a minute or two late.
        #
        # Reducing the batch's SIZE or pre-filtering its frames was the
        # alternative and is worse: MediaPipe reports "No hands detected"
        # constantly in this lighting, and the Gemini fallback exists to rescue
        # frames where a pill was found with no hand recognised. A hand-based
        # filter would remove exactly the evidence that fallback depends on.
        # So every frame is still examined; the batch just stops being greedy.
        # Two threads, not cpu_count()-1.
        #
        # os.cpu_count() reports LOGICAL processors. This machine answers 8 and
        # has 4 physical cores, so "cpu_count() - 1" asked for 7 and the pill
        # detector alone wanted nearly twice the real machine. Alongside torch
        # (MobileNetV3, DINOv2 and ultralytics at 4 apiece) and InsightFace,
        # demand reached about 23 threads on 4 cores, and everything slowed
        # down together: one frame through the item indexer costs 1.2 s on an
        # idle machine and was measured at 29 s and 69 s during a medication
        # window, which is where the three-minute lag in the item feed came
        # from -- eight queued frames at 25 s each.
        #
        # Two costs nothing here. Measured 23 Oct 2026 over 60 frames:
        # 2 threads 30.9 s, 3 threads 39.9 s, 4 threads 40.3 s, 6 threads
        # 37.2 s, 7 threads 31.7 s. The model is flat in thread count and
        # slowest in the middle, so the extra five threads bought nothing and
        # starved every other model in the process.
        _threads = int(os.environ.get("PILL_DETECTOR_THREADS", 2))
        _opts = ort.SessionOptions()
        _opts.intra_op_num_threads = max(1, _threads)
        _opts.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            model_path,
            sess_options=_opts,
            providers=["CPUExecutionProvider"]
        )
        print(f"Pill detector using {_opts.intra_op_num_threads} thread(s); "
              f"{os.cpu_count()} logical processors reported")
        self.input_name  = self.session.get_inputs()[0].name
        self.input_shape = self.session.get_inputs()[0].shape
        self.img_size    = self.input_shape[2] if isinstance(self.input_shape[2], int) else 640
        print(f"Pill detection model loaded. Input shape: {self.input_shape}")

    def preprocess(self, frame):
        """Resize and normalize a single frame for model input."""
        img = cv2.resize(frame, (self.img_size, self.img_size))
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        img = img.astype(np.float32) / 255.0
        img = np.transpose(img, (2, 0, 1))  # (3, 640, 640)
        return img

    def preprocess_single(self, frame):
        """Preprocess a single frame for model input (dynamic batch size 1)."""
        img = self.preprocess(frame)
        return np.expand_dims(img, axis=0)

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

            # Too big to be a pill anybody could swallow. See MAX_PILL_FRAC.
            if max(x2 - x1, y2 - y1) > MAX_PILL_FRAC * orig_w:
                continue

            # Aspect ratio filter: pills are roughly round or oval
            # Fingers are elongated (aspect ratio > 3:1) — reject them
            det_w = max(1, x2 - x1)
            det_h = max(1, y2 - y1)
            aspect = max(det_w / det_h, det_h / det_w)
            if aspect > 3.0:
                continue  # too elongated, likely a finger

            # Minimum size filter: very tiny detections are noise
            if det_w < 8 or det_h < 8:
                continue

            detections.append({
                "class":      PILL_CLASSES.get(class_id, f"class_{class_id}"),
                "class_id":   class_id,
                "confidence": round(confidence, 3),
                "bbox":       {"x1": x1, "y1": y1, "x2": x2, "y2": y2},
                "center":     {"x": (x1 + x2) // 2, "y": (y1 + y2) // 2}
            })

        return self._apply_nms(detections)

    def _apply_nms(self, detections, iou_threshold=0.85):
        """Remove overlapping duplicate detections. High threshold keeps tightly grouped pills."""
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
        input_tensor = self.preprocess_single(frame)
        outputs = self.session.run(None, {self.input_name: input_tensor})
        return self.postprocess(outputs, orig_h, orig_w)

    def detect_batch(self, frames):
        """
        Run detection across temporal buffer frames with dynamic batching.
        Feeds the exact number of frames dynamically without padding blanks.
        """
        if not frames:
            return []

        results = []
        n = len(frames)
        batch_size_chunk = 8

        for chunk_start in range(0, n, batch_size_chunk):
            chunk = frames[chunk_start:chunk_start + batch_size_chunk]
            k = len(chunk)
            batch_tensor = np.zeros((k, 3, self.img_size, self.img_size), dtype=np.float32)
            orig_sizes = []

            for j, frame_data in enumerate(chunk):
                frm = frame_data["frame"]
                orig_sizes.append(frm.shape[:2])  # (h, w)
                batch_tensor[j] = self.preprocess(frm)

            # Single ONNX call for exact k frames
            raw_outputs = self.session.run(None, {self.input_name: batch_tensor})

            # raw_outputs[0] shape: (k, num_preds, 6) — parse each real frame
            for j, frame_data in enumerate(chunk):
                orig_h, orig_w = orig_sizes[j]
                # Extract single-frame output
                single_output = [raw_outputs[0][j:j+1]]
                detections = self.postprocess(single_output, orig_h, orig_w)
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

# ── A pill in the palm, found by shape rather than by the model ────────────
#
# best_model.onnx does not detect this wearer's tablets. Measured 23 Oct 2026
# on the frames the pipeline itself stored at 02:58: a white tablet plainly in
# the palm, and the model returned nothing for it at full resolution, nothing
# on a crop of the hand, and nothing on that crop upscaled three times. What it
# DID return, at 0.39, was the toes of a teddy bear on the bed 180 px away.
#
# That is not a threshold to tune. The model was trained on pills photographed
# close up against plain backgrounds, and a 45-pixel disc on skin under one
# lamp is outside it. Every gate downstream -- pill-in-hand, the three phases,
# the confidence policy -- was starved of a true candidate for weeks.
#
# This finds the other kind: bright, barely saturated, roughly circular, pill
# sized, and ONLY inside the hand box MediaPipe has already drawn. Searching
# the palm instead of the frame is what makes so blunt a rule safe -- the
# teddy bear, the mouse and the phone are all outside it by construction.
#
# It identifies nothing. It says "something small, pale and round is in this
# hand", and the three-phase sequence supplies the corroboration, exactly as
# it does for the model's own detections.
#
# Measured on this wearer's stored frames: found the tablet at (540, 596) and
# (550, 531) in the two 02:58 frames where it is visible, and produced a blob
# inside a hand in 2 of 62 ordinary keyframes.
PALM_PILL_MIN_AREA = float(os.environ.get("PALM_PILL_MIN_AREA", 150))
PALM_PILL_MAX_HAND_FRAC = float(os.environ.get("PALM_PILL_MAX_HAND_FRAC", 0.08))
PALM_PILL_MIN_CIRCULARITY = float(os.environ.get("PALM_PILL_MIN_CIRCULARITY", 0.55))
PALM_PILL_VALUE_PCT = float(os.environ.get("PALM_PILL_VALUE_PCT", 97))
PALM_PILL_MAX_SAT = float(os.environ.get("PALM_PILL_MAX_SAT", 70))
PALM_PILL_CONFIDENCE = float(os.environ.get("PALM_PILL_CONFIDENCE", 0.55))


def find_pills_in_palm(frame, hand_bboxes):
    """Pill-shaped bright blobs inside the given hand boxes.

    Returns detections in the same shape the ONNX detector produces, so the
    rest of the pipeline cannot tell which found them.
    """
    if frame is None or not hand_bboxes:
        return []

    h, w = frame.shape[:2]
    out = []
    for hb in hand_bboxes:
        try:
            x1 = max(0, int(hb["x1"])); y1 = max(0, int(hb["y1"]))
            x2 = min(w, int(hb["x2"])); y2 = min(h, int(hb["y2"]))
        except (KeyError, TypeError, ValueError):
            continue
        if x2 - x1 < 20 or y2 - y1 < 20:
            continue

        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            continue

        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        value, sat = hsv[:, :, 2], hsv[:, :, 1]
        # Brighter than almost all of the hand around it, and close to white.
        # A percentile rather than a fixed level, because a palm in lamplight
        # and a palm in daylight share no absolute brightness.
        cutoff = np.percentile(value, PALM_PILL_VALUE_PCT)
        mask = ((value >= cutoff) & (sat < PALM_PILL_MAX_SAT)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        hand_area = max(1, (x2 - x1) * (y2 - y1))
        for contour in contours:
            area = cv2.contourArea(contour)
            if area < PALM_PILL_MIN_AREA:
                continue
            if area / hand_area > PALM_PILL_MAX_HAND_FRAC:
                continue          # a sleeve cuff or a lit background, not a pill
            (cx, cy), radius = cv2.minEnclosingCircle(contour)
            if radius <= 0:
                continue
            circularity = area / (np.pi * radius * radius)
            if circularity < PALM_PILL_MIN_CIRCULARITY:
                continue

            bx1, by1 = int(cx - radius) + x1, int(cy - radius) + y1
            bx2, by2 = int(cx + radius) + x1, int(cy + radius) + y1
            out.append({
                "class": "pill",
                "class_id": 0,
                # Fixed, and deliberately in the band that asks a person rather
                # than one that records a dose by itself: shape is evidence,
                # not identification.
                "confidence": round(PALM_PILL_CONFIDENCE, 3),
                "source": "palm_shape",
                "circularity": round(float(circularity), 2),
                "bbox": {"x1": max(0, bx1), "y1": max(0, by1),
                         "x2": min(w, bx2), "y2": min(h, by2)},
                "center": {"x": int(cx) + x1, "y": int(cy) + y1},
            })
    return out
