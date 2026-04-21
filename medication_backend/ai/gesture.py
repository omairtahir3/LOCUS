import mediapipe as mp 
import numpy as np 
import cv2 
from collections import deque


class GestureDetector:
    """
    Hand gesture detector optimized for a body/chest-mounted wearable camera.
    
    Since the camera faces outward and cannot see the user's face,
    we track hand movement direction instead of hand-to-mouth proximity.
    
    Detection logic:
    1. Pill visible in frame (from PillDetector)
    2. Hand detected holding something (pinch/grip gesture)
    3. Hand moves UPWARD in frame toward the body (taking motion)
    4. Hand disappears from upper portion of frame (reached mouth off-camera)
    """

    def __init__(self, motion_history_size=20):
        self.mp_hands = mp.solutions.hands
        self.mp_draw  = mp.solutions.drawing_utils

        self.hands = self.mp_hands.Hands(
            static_image_mode=False,
            max_num_hands=2,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.5
        )

        # Store hand position history to track motion direction
        self.hand_position_history = deque(maxlen=motion_history_size)
        self.motion_history_size = motion_history_size

    def detect_hands(self, frame):
        """Detect hands and return landmark positions."""
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        results = self.hands.process(rgb)

        hands_data = []
        if results.multi_hand_landmarks:
            h, w = frame.shape[:2]
            for hand_landmarks in results.multi_hand_landmarks:
                landmarks = []
                for lm in hand_landmarks.landmark:
                    landmarks.append({
                        "x": lm.x * w,
                        "y": lm.y * h,
                        "z": lm.z
                    })

                # Calculate hand center (palm center = landmark 9)
                palm = landmarks[9]
                hands_data.append({
                    "landmarks": landmarks,
                    "center_x": palm["x"],
                    "center_y": palm["y"],
                    "wrist_y": landmarks[0]["y"],  # wrist position
                })

        return hands_data

    def is_gripping_gesture(self, landmarks, threshold=200):
        """
        Detect if hand is in a gripping or pinching position.
        Consistent with holding pills or tablets.

        Threshold is in pixels — set to 200px to handle multiple pills
        where fingers are more spread apart.

        Checks:
        - Thumb and index finger close together (pill pinch)
        - Fingers curled inward (full grip / holding pills)
        - Any closed fist pattern
        """
        thumb_tip  = landmarks[4]
        index_tip  = landmarks[8]
        middle_tip = landmarks[12]
        ring_tip   = landmarks[16]
        index_pip  = landmarks[6]   # index middle joint
        middle_pip = landmarks[10]
        ring_pip   = landmarks[14]

        # Pinch: thumb and index close together
        pinch_dist = np.sqrt(
            (thumb_tip["x"] - index_tip["x"])**2 +
            (thumb_tip["y"] - index_tip["y"])**2
        )
        is_pinching = pinch_dist < threshold
        pinch_conf  = max(0.0, 1.0 - (pinch_dist / (threshold * 2)))

        # Curl: fingertips below their middle joint (fingers bent inward)
        index_curled = index_tip["y"] > index_pip["y"]
        middle_curled = middle_tip["y"] > middle_pip["y"]
        ring_curled = ring_tip["y"] > ring_pip["y"]
        is_curled = index_curled or middle_curled or ring_curled

        grip_confidence = pinch_conf
        if index_curled:
            grip_confidence = min(1.0, grip_confidence + 0.30)
        if middle_curled:
            grip_confidence = min(1.0, grip_confidence + 0.20)
        if ring_curled:
            grip_confidence = min(1.0, grip_confidence + 0.15)

        return (is_pinching or is_curled), round(grip_confidence, 3)

    def compute_upward_motion(self):
        """
        Analyze hand position history to detect upward motion.
        
        For a body camera, taking a pill = hand moves UP in the frame
        (toward the mouth which is above the camera's field of view).
        
        Returns motion score 0.0-1.0:
        - 1.0 = strong consistent upward movement
        - 0.0 = no movement or downward movement
        """
        if len(self.hand_position_history) < 3:
            return 0.0

        positions = list(self.hand_position_history)

        # Compare Y positions over time — lower Y value = higher in frame
        y_values = [p["y"] for p in positions]

        # Calculate overall Y displacement (negative = moved up in frame)
        y_displacement = y_values[-1] - y_values[0]

        # Also check consistency — sustained upward motion, not just jitter
        upward_frames = sum(
            1 for i in range(1, len(y_values))
            if y_values[i] < y_values[i-1]
        )
        consistency = upward_frames / (len(y_values) - 1)

        # Normalize displacement to a score
        # A displacement of 30px upward = strong motion (body cam / short videos)
        displacement_score = min(1.0, max(0.0, -y_displacement / 30.0))

        # Weight consistency higher — sustained upward movement matters more
        motion_score = displacement_score * 0.4 + consistency * 0.6
        return round(float(motion_score), 3)

    def is_hand_exiting_top(self, hand_center_y, frame_height, threshold_ratio=0.2):
        """
        Check if hand is near or exiting the top of the frame.
        For a body camera this means the hand is reaching toward the mouth.
        threshold_ratio=0.2 means top 20% of frame.
        """
        threshold_y = frame_height * threshold_ratio
        is_near_top = hand_center_y < threshold_y

        # Score based on how close to top — closer = higher score
        proximity_score = max(0.0, 1.0 - (hand_center_y / (frame_height * threshold_ratio)))
        proximity_score = min(1.0, proximity_score)

        return is_near_top, round(float(proximity_score), 3)

    def _compute_hand_bbox(self, landmarks, frame_h, frame_w, padding=20):
        """
        Compute a bounding box around the hand from 21 MediaPipe landmarks.
        Adds configurable padding (pixels) around the extremes.
        Returns dict {x1, y1, x2, y2} in pixel coordinates.
        """
        xs = [lm["x"] for lm in landmarks]
        ys = [lm["y"] for lm in landmarks]
        x1 = max(0, int(min(xs)) - padding)
        y1 = max(0, int(min(ys)) - padding)
        x2 = min(frame_w, int(max(xs)) + padding)
        y2 = min(frame_h, int(max(ys)) + padding)
        return {"x1": x1, "y1": y1, "x2": x2, "y2": y2}

    def analyze_frame(self, frame):
        """
        Full gesture analysis on a single frame for body camera context.
        Returns gesture scores relevant to medication-taking detection.
        Includes hand_bbox for spatial overlap checking with pill detections.
        """
        h, w = frame.shape[:2]
        hands = self.detect_hands(frame)

        results = {
            "hands_detected":       len(hands),
            "grip_detected":        False,
            "grip_confidence":      0.0,
            "upward_motion_score":  0.0,
            "hand_near_top":        False,
            "hand_near_top_score":  0.0,
            "gesture_score":        0.0,
            "hand_bbox":            None,   # bounding box of primary hand
            "all_hand_bboxes":      [],     # bounding boxes of all detected hands
        }

        if not hands:
            # No hand detected — don't clear history so motion can be
            # computed when hands reappear (brief occlusions are common)
            return results

        # Compute bounding boxes for all detected hands
        all_bboxes = []
        for hand_data in hands:
            bbox = self._compute_hand_bbox(hand_data["landmarks"], h, w)
            all_bboxes.append(bbox)
        results["all_hand_bboxes"] = all_bboxes

        # Use the hand with highest position (closest to top of frame)
        primary_idx = min(range(len(hands)), key=lambda i: hands[i]["center_y"])
        primary_hand = hands[primary_idx]
        results["hand_bbox"] = all_bboxes[primary_idx]

        # Track position history
        self.hand_position_history.append({
            "x": primary_hand["center_x"],
            "y": primary_hand["center_y"],
        })

        # Check grip
        grip, grip_conf = self.is_gripping_gesture(primary_hand["landmarks"])
        results["grip_detected"]   = grip
        results["grip_confidence"] = grip_conf

        # Check upward motion
        motion_score = self.compute_upward_motion()
        results["upward_motion_score"] = motion_score

        # Check if hand is near top of frame (approaching mouth)
        near_top, top_score = self.is_hand_exiting_top(primary_hand["center_y"], h)
        results["hand_near_top"]       = near_top
        results["hand_near_top_score"] = top_score

        # Combined gesture score — motion weighted higher than grip
        results["gesture_score"] = round(
            grip_conf    * 0.30 +
            motion_score * 0.45 +
            top_score    * 0.25,
            3
        )

        return results

    def analyze_batch(self, frames):
        """Analyze gesture across temporal buffer frames."""
        self.hand_position_history.clear()
        batch_results = []
        for frame_data in frames:
            gesture = self.analyze_frame(frame_data["frame"])
            gesture["timestamp"] = frame_data["timestamp"]
            gesture["frame_id"]  = frame_data["id"]
            batch_results.append(gesture)
        return batch_results

    def compute_gesture_sequence_score(self, batch_results):
        """
        Score the full gesture sequence across the temporal buffer.
        
        A valid medication-taking gesture sequence should show:
        1. Hand with grip in lower part of frame (picking up pill)
        2. Hand moving upward consistently
        3. Hand reaching top of frame or disappearing (reaching mouth)
        """
        if not batch_results:
            return 0.0

        gesture_scores = [r["gesture_score"] for r in batch_results]
        motion_scores  = [r["upward_motion_score"] for r in batch_results]
        grip_scores    = [r["grip_confidence"] for r in batch_results]

        peak_gesture  = max(gesture_scores)
        avg_gesture   = np.mean(gesture_scores)
        peak_motion   = max(motion_scores)
        avg_grip      = np.mean(grip_scores)

        # Sequence score — peak moment weighted heavily
        sequence_score = (
            peak_gesture * 0.40 +
            avg_gesture  * 0.25 +
            peak_motion  * 0.20 +
            avg_grip     * 0.15
        )

        return round(float(sequence_score), 3)

    def close(self):
        self.hands.close()