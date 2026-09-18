#!/usr/bin/env python3
"""
LOCUS Personal Belongings Dataset Frame Extraction Utility.

Extracts sharp, high-quality candidate frames from recorded chest-camera video
footage at regular time intervals (1.0 - 2.0s) for YOLO labeling.

Features:
- Supports single video file or an entire folder of video clips.
- Adjustable sampling interval (default: 1.5s).
- Blur / motion-blur detection (filters out rapid head movement).
- Automatically sets up a YOLO dataset directory structure:
    datasets/personal_items_dataset/
      ├── images/
      │   ├── train/
      │   └── val/
      └── labels/
          ├── train/
          └── val/
- Generates the ready-to-use dataset.yaml descriptor.
"""

import os
import sys
import argparse
import glob
import cv2
import numpy as np


def compute_sharpness(image_bgr: np.ndarray) -> float:
    """Compute Laplacian variance as a proxy for image sharpness / blur."""
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def process_single_video(
    video_path: str,
    output_dir: str,
    interval_seconds: float = 1.5,
    blur_threshold: float = 40.0,
    val_split_pct: float = 0.20,
    global_counter: int = 0
) -> tuple[int, int]:
    """Extract frames from a single video and split into train/val folders."""
    train_img_dir = os.path.join(output_dir, "images", "train")
    val_img_dir = os.path.join(output_dir, "images", "val")

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[Error] Failed to open video: {video_path}")
        return 0, 0

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_s = total_frames / fps
    frame_step = max(1, int(round(fps * interval_seconds)))

    video_basename = os.path.splitext(os.path.basename(video_path))[0]
    print(f"\nProcessing Video: {video_basename}")
    print(f"  Total Frames:   {total_frames} (~{duration_s/60.0:.1f} mins @ {fps:.1f} FPS)")
    print(f"  Frame Step:     Every {frame_step} frames ({interval_seconds}s)")

    extracted = 0
    skipped_blur = 0
    frame_idx = 0
    val_step = int(1.0 / max(0.01, val_split_pct))

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_step == 0:
            sharpness = compute_sharpness(frame)
            if sharpness < blur_threshold:
                skipped_blur += 1
                frame_idx += 1
                continue

            extracted += 1
            global_idx = global_counter + extracted
            is_val = (global_idx % val_step == 0)
            target_dir = val_img_dir if is_val else train_img_dir

            timestamp_s = frame_idx / fps
            out_filename = f"{video_basename}_f{frame_idx:06d}_{int(timestamp_s)}s.jpg"
            out_path = os.path.join(target_dir, out_filename)
            cv2.imwrite(out_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 95])

            if extracted % 25 == 0:
                print(f"  -> Extracted {extracted} frames ({skipped_blur} blur-skipped)...")

        frame_idx += 1

    cap.release()
    return extracted, skipped_blur


def extract_dataset(
    input_path: str,
    output_dir: str,
    interval_seconds: float = 1.5,
    blur_threshold: float = 40.0,
    val_split_pct: float = 0.20
):
    """Extract frames from video file(s) and create full dataset structure."""
    train_img_dir = os.path.join(output_dir, "images", "train")
    val_img_dir = os.path.join(output_dir, "images", "val")
    train_lbl_dir = os.path.join(output_dir, "labels", "train")
    val_lbl_dir = os.path.join(output_dir, "labels", "val")

    for d in [train_img_dir, val_img_dir, train_lbl_dir, val_lbl_dir]:
        os.makedirs(d, exist_ok=True)

    # Collect video files
    video_files = []
    if os.path.isfile(input_path):
        video_files.append(input_path)
    elif os.path.isdir(input_path):
        for ext in ("*.mp4", "*.mkv", "*.avi", "*.mov", "*.MP4", "*.MKV", "*.MOV"):
            video_files.extend(glob.glob(os.path.join(input_path, ext)))
            video_files.extend(glob.glob(os.path.join(input_path, "**", ext), recursive=True))
        video_files = sorted(list(set(video_files)))

    if not video_files:
        print(f"[Error] No video files found at: {input_path}")
        return

    print("=" * 65)
    print("LOCUS DATASET FRAME EXTRACTOR")
    print("=" * 65)
    print(f"Found {len(video_files)} video file(s)")
    print(f"Output Directory:   {output_dir}")
    print(f"Sampling Interval:  {interval_seconds}s")
    print(f"Validation Split:   {int(val_split_pct * 100)}%")
    print("=" * 65)

    total_extracted = 0
    total_skipped = 0

    for vid in video_files:
        ext_count, skip_count = process_single_video(
            video_path=vid,
            output_dir=output_dir,
            interval_seconds=interval_seconds,
            blur_threshold=blur_threshold,
            val_split_pct=val_split_pct,
            global_counter=total_extracted
        )
        total_extracted += ext_count
        total_skipped += skip_count

    # Generate template dataset.yaml
    yaml_content = f"""# LOCUS Custom Personal Belongings Dataset Descriptor
path: {os.path.abspath(output_dir)}
train: images/train
val: images/val

# Classes (Populated during Roboflow / LabelImg export)
names:
  0: key
  1: wallet
  2: phone
  3: watch
  4: glasses
  5: mug
"""
    yaml_path = os.path.join(output_dir, "dataset.yaml")
    with open(yaml_path, "w") as f:
        f.write(yaml_content)

    print("\n" + "=" * 65)
    print("FRAME EXTRACTION COMPLETE")
    print("=" * 65)
    print(f"Total Frames Extracted: {total_extracted}")
    print(f"  - Train: {len(os.listdir(train_img_dir))} images in {train_img_dir}")
    print(f"  - Val:   {len(os.listdir(val_img_dir))} images in {val_img_dir}")
    print(f"Blurry Frames Skipped:  {total_skipped}")
    print(f"Dataset Descriptor:     {yaml_path}")
    print("=" * 65)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract frames from recorded video(s) for YOLO personal belongings fine-tuning.")
    parser.add_argument("--input", "-i", "--video", "-v", dest="input_path", type=str, required=True, help="Path to input video file or folder of videos")
    parser.add_argument("--output", "-o", type=str, default="datasets/personal_items_dataset", help="Destination dataset folder")
    parser.add_argument("--interval", "-t", type=float, default=1.5, help="Sampling interval in seconds (default: 1.5s)")
    parser.add_argument("--blur-thresh", "-b", type=float, default=40.0, help="Laplacian blur threshold (lower = allow softer frames)")
    parser.add_argument("--val-split", type=float, default=0.20, help="Validation set fraction (default: 0.20 = 20%%)")

    args = parser.parse_args()
    extract_dataset(
        input_path=args.input_path,
        output_dir=args.output,
        interval_seconds=args.interval,
        blur_threshold=args.blur_thresh,
        val_split_pct=args.val_split
    )
