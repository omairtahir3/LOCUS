"""
Test script for LOCUS medication detection pipeline.
Optimized for body/chest-mounted wearable camera.

Usage:
    # Test with webcam (simulate body camera)
    python ai/test_pipeline.py --source 0

    # Test with a video file
    python ai/test_pipeline.py --source path/to/video.mp4

    # Single frame test (quick check)
    python ai/test_pipeline.py --source 0 --single-frame

    # Show live annotated video window
    python ai/test_pipeline.py --source 0 --display
"""

import argparse
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cv2
import numpy as np
from ai.keyframe import KeyframeExtractor, VideoSource
from ai.detector import PillDetector
from ai.gesture import GestureDetector
from ai.pipeline import MedicationDetectionPipeline


def test_pill_detector(frame):
    """Test the ONNX pill detection model on a single frame."""
    print("\n--- Testing Pill Detector (ONNX Model) ---")
    try:
        detector = PillDetector("ai/best_model.onnx")
        detections = detector.detect(frame)
        print(f"Pills detected: {len(detections)}")
        for d in detections:
            print(f"  {d['class']:10} confidence: {d['confidence']:.2f}  "
                  f"bbox: ({d['bbox']['x1']},{d['bbox']['y1']}) → ({d['bbox']['x2']},{d['bbox']['y2']})")
        if not detections:
            print("  No pills detected in frame — try holding a tablet/capsule in view")
        return detector, detections
    except FileNotFoundError as e:
        print(f"  ERROR: {e}")
        return None, []


def test_gesture_detector(frame):
    """
    Test gesture detection for body camera context.
    No face detection — tracks grip, upward motion, and hand proximity to top of frame.
    """
    print("\n--- Testing Gesture Detector (Body Camera Mode) ---")
    gesture = GestureDetector()
    result = gesture.analyze_frame(frame)

    print(f"Hands detected:        {result['hands_detected']}")
    print(f"Grip detected:         {result['grip_detected']}")
    print(f"Grip confidence:       {result['grip_confidence']:.2f}")
    print(f"Upward motion score:   {result['upward_motion_score']:.2f}")
    print(f"Hand near top:         {result['hand_near_top']}")
    print(f"Hand near top score:   {result['hand_near_top_score']:.2f}")
    print(f"Overall gesture score: {result['gesture_score']:.2f}")

    if result['hands_detected'] == 0:
        print("  No hands detected — make sure your hand is visible in frame")

    gesture.close()
    return result


def test_full_pipeline(source, display=False):
    """
    Run the full medication detection pipeline.
    Prints analysis results every 10 seconds.
    """
    print(f"\n--- Running Full Pipeline ---")
    print(f"Source: {source}")
    print(f"Display: {display}")
    print("Press Q to quit\n")

    pipeline = MedicationDetectionPipeline()

    cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        print(f"ERROR: Cannot open source: {source}")
        return

    frame_count  = 0
    frames_in_ai_buffer = 0
    blurry_rejected = 0
    analyze_every = 30  # analyze more frequently for shorter videos

    # Track how many files are currently in storage to count new ones later
    import os, glob
    storage_dir = pipeline.extractor.storage.storage_dir if pipeline.extractor.storage else ""
    initial_storage_count = len(glob.glob(os.path.join(storage_dir, "*.json"))) if storage_dir else 0

    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("End of video source")
                break

            frame_count += 1

            # Extract keyframe
            keyframe = pipeline.extractor.process_frame(frame)
            if keyframe:
                frames_in_ai_buffer += 1

            # Check if frame was rejected from AI buffer due to blur
            if not keyframe and pipeline.extractor.frame_count > 0:
                blur_score = pipeline.extractor.compute_blur_score(frame)
                if blur_score < pipeline.extractor.blur_threshold:
                    blurry_rejected += 1

            if display and keyframe:
                # Annotate with pill detections
                try:
                    detections = pipeline.detector.detect(frame)
                    annotated  = pipeline.detector.annotate_frame(frame, detections)

                    # Overlay gesture info
                    gesture = pipeline.gesture.analyze_frame(frame)
                    h, w = frame.shape[:2]

                    # Draw upward motion indicator
                    motion_bar_h = int(gesture["upward_motion_score"] * 100)
                    cv2.rectangle(annotated, (w - 30, h - motion_bar_h), (w - 10, h),
                                  (0, 212, 184), -1)
                    cv2.putText(annotated, "Motion", (w - 50, h - 110),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 212, 184), 1)

                    # Draw hand near top indicator
                    if gesture["hand_near_top"]:
                        cv2.putText(annotated, "HAND AT TOP", (10, 60),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

                    # Draw grip indicator
                    grip_color = (0, 255, 0) if gesture["grip_detected"] else (0, 0, 255)
                    cv2.putText(annotated, f"Grip: {gesture['grip_confidence']:.2f}",
                                (10, 90), cv2.FONT_HERSHEY_SIMPLEX, 0.6, grip_color, 2)

                    # Draw gesture score
                    cv2.putText(annotated, f"Gesture: {gesture['gesture_score']:.2f}",
                                (10, 120), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 212, 184), 2)

                    # Draw buffer size and blur info
                    buf_size = len(pipeline.extractor.get_buffer())
                    cv2.putText(annotated, f"Buffer: {buf_size} frames",
                                (10, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)
                    cv2.putText(annotated, f"Blur rejected: {blurry_rejected}",
                                (10, h - 20), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

                    # Show blur score of current frame
                    cur_blur = pipeline.extractor.compute_blur_score(frame)
                    blur_color = (0, 255, 0) if cur_blur >= pipeline.extractor.blur_threshold else (0, 0, 255)
                    cv2.putText(annotated, f"Blur: {cur_blur:.0f}",
                                (w - 130, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.6, blur_color, 2)

                    cv2.imshow("LOCUS - Medication Detection (Body Camera)", annotated)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break
                except Exception as e:
                    cv2.imshow("LOCUS - Raw Feed", frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        break

            # Analyze buffer every N frames
            if frame_count % analyze_every == 0:
                buffer_size = len(pipeline.extractor.get_buffer())
                print(f"\n[DEBUG] Frame {frame_count} | AI Buffer: {buffer_size} | Blurry rejected: {blurry_rejected}")
                result = pipeline.analyze_buffer()
                if result:
                    pd = result['phase_details']
                    p1 = pd['phase1_medicine_visible']
                    p2 = pd['phase2_grip_and_motion']
                    p3 = pd['phase3_medicine_gone']
                    passed = pd['phases_passed']

                    print(f"{'='*55}")
                    print(f"Frame: {frame_count}")
                    print(f"-" * 55)
                    mark1 = "PASS" if p1['pass'] else "FAIL"
                    mark2 = "PASS" if p2['pass'] else "FAIL"
                    mark3 = "PASS" if p3['pass'] else "FAIL"
                    fq = result.get('frame_quality', {})
                    print(f"Frame quality:  avg_blur={fq.get('avg_blur_score', 0):.1f}  all_sharp={fq.get('all_frames_sharp', False)}")
                    print(f"Phase 1 - Medicine visible:   [{mark1}]  score={p1['score']:.2f}  pill={p1['pill_score']:.2f}")
                    print(f"Phase 2 - Grip/Motion:        [{mark2}]  score={p2['score']:.2f}  grip={p2['grip']:.2f}  motion={p2['motion']:.2f}")
                    print(f"Phase 3 - Medicine gone:      [{mark3}]  score={p3['score']:.2f}  drop={p3['pill_drop']:.2f}")
                    print(f"-" * 55)
                    print(f"Phases passed:    {passed}/3")
                    print(f"Confidence:       {result['final_confidence']:.2f}")
                    print(f"Classification:   {result['classification']}")
                    print(f"Action:           {result['action']}")
                    print(f"{'='*55}\n")
                else:
                    print(f"[DEBUG] analyze_buffer() returned None — buffer is empty, no frames to analyze")

    finally:
        # Flush remaining window candidates
        if hasattr(pipeline.extractor, '_flush_window'):
            pipeline.extractor._flush_window()

        final_storage_count = len(glob.glob(os.path.join(storage_dir, "*.json"))) if storage_dir else 0
        frames_saved_to_disk = max(0, final_storage_count - initial_storage_count)

        print(f"\n[DEBUG] Pipeline finished.")
        print(f"  Total frames read:      {frame_count}")
        print(f"  Frames in AI buffer:    {frames_in_ai_buffer}")
        print(f"  Blurry rejected (AI):   {blurry_rejected}")
        print(f"  Frames saved to DISK:   {frames_saved_to_disk} (best frame/sec)")
        print(f"  Final AI buffer size:   {len(pipeline.extractor.get_buffer())}")
        cap.release()
        if display:
            cv2.destroyAllWindows()
        pipeline.gesture.close()


def test_single_frame(source):
    """Capture one frame and run both detectors on it."""
    print(f"\nCapturing single frame from source: {source}")
    cap = cv2.VideoCapture(source)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print(f"ERROR: Could not read from source: {source}")
        return

    print(f"Frame captured: {frame.shape[1]}x{frame.shape[0]}")

    # Run pill detector
    detector, detections = test_pill_detector(frame)

    # Run gesture detector
    gesture_result = test_gesture_detector(frame)

    # Show combined confidence estimate
    if detector:
        pill_score    = max((d["confidence"] for d in detections), default=0.0)
        gesture_score = gesture_result["gesture_score"]
        combined      = (pill_score * 0.70) + (gesture_score * 0.30)
        print(f"\n--- Combined Estimate ---")
        print(f"Pill score:     {pill_score:.2f}")
        print(f"Gesture score:  {gesture_score:.2f}")
        print(f"Combined:       {combined:.2f}")
        if combined >= 0.85:
            print("Classification: AUTO VERIFIED")
        elif combined >= 0.70:
            print("Classification: NEEDS CONFIRMATION")
        else:
            print("Classification: UNVERIFIED")


def main():
    parser = argparse.ArgumentParser(
        description="LOCUS Medication Detection Pipeline Test (Body Camera Mode)"
    )
    parser.add_argument("--source",       default="0",
                        help="Video source: 0 for webcam, or path to video file")
    parser.add_argument("--display",      action="store_true",
                        help="Show annotated video window during pipeline run")
    parser.add_argument("--single-frame", action="store_true",
                        help="Test on a single captured frame only (quick test)")
    args = parser.parse_args()

    source = int(args.source) if args.source.isdigit() else args.source

    print("=" * 45)
    print("LOCUS Medication Detection — Body Camera")
    print("=" * 45)
    print(f"Mode: {'Single Frame' if args.single_frame else 'Full Pipeline'}")
    print(f"Source: {'Webcam' if source == 0 else source}")
    print()

    if args.single_frame:
        test_single_frame(source)
    else:
        test_full_pipeline(source, display=args.display)


if __name__ == "__main__":
    main()