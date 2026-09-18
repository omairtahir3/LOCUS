#!/usr/bin/env python3
"""
LOCUS Kaggle Fine-Tuning Workflow for Single-Class Egocentric Key Detector.

Instructions for Kaggle GPU Notebook (T4 / P100):
1. Create a new Kaggle Notebook with GPU enabled (Settings -> Accelerator -> GPU T4 x2 or P100).
2. Upload your labeled dataset zip (containing 'dataset.yaml', 'images/', 'labels/').
3. Copy/paste this script or run the cells below.
4. Download the generated 'yolov8n_key.pt' and 'yolov8n_key.onnx' models.
"""

import os
import shutil

# Step 1: Install Ultralytics and ONNX dependencies
# In Kaggle Notebook: !pip install ultralytics onnx onnxruntime

def train_key_detector():
    from ultralytics import YOLO

    print("=" * 60)
    print("LOCUS YOLOv8n Key Detector Fine-Tuning")
    print("=" * 60)

    # 1. Locate dataset.yaml
    # If uploaded as a Kaggle dataset at /kaggle/input/key-dataset/dataset.yaml:
    dataset_yaml = "/kaggle/input/key-dataset/dataset.yaml"
    if not os.path.exists(dataset_yaml):
        # Fallback local path
        dataset_yaml = "dataset.yaml"

    print(f"Using dataset config: {dataset_yaml}")

    # 2. Load pre-trained YOLOv8 Nano model
    # yolov8n.pt provides rich low-level edge and texture representations
    model = YOLO("yolov8n.pt")

    # 3. Train on single class 'key'
    # Optimized for first-person egocentric hand-held object detection
    results = model.train(
        data=dataset_yaml,
        epochs=60,
        imgsz=640,
        batch=16,
        patience=15,
        save=True,
        device=0,               # GPU device
        workers=4,
        # Egocentric data augmentations
        degrees=10.0,           # Slight tilt
        translate=0.1,          # Translation
        scale=0.5,              # Scale variation (close vs mid distance)
        shear=2.0,
        perspective=0.0005,
        flipud=0.0,             # Egocentric view is rarely upside down
        fliplr=0.5,             # Left/right hand symmetry
        hsv_h=0.015,            # Color hue tolerance
        hsv_s=0.7,              # Saturation variation
        hsv_v=0.4,              # Lighting / shadow tolerance
        mosaic=1.0,             # Contextual background mixing
        mixup=0.1,
        project="locus_key_training",
        name="yolov8n_key_exp"
    )

    print("\n" + "=" * 60)
    print("TRAINING FINISHED. VALIDATING MODEL...")
    print("=" * 60)

    # 4. Evaluate metrics
    metrics = model.val()
    print(f"mAP50:    {metrics.box.map50:.4f}")
    print(f"mAP50-95: {metrics.box.map:.4f}")

    # 5. Export to ONNX for production edge inference
    print("\n" + "=" * 60)
    print("EXPORTING MODEL TO ONNX...")
    print("=" * 60)

    onnx_path = model.export(
        format="onnx",
        dynamic=True,           # Support dynamic batching/resolution
        opset=17,
        simplify=True
    )
    print(f"ONNX Model Exported to: {onnx_path}")

    # 6. Copy artifacts to Kaggle working output directory
    output_dir = "/kaggle/working"
    best_pt = os.path.join("locus_key_training", "yolov8n_key_exp", "weights", "best.pt")
    if os.path.exists(best_pt):
        shutil.copy(best_pt, os.path.join(output_dir, "yolov8n_key.pt"))
        print(f"Saved PyTorch weights: {os.path.join(output_dir, 'yolov8n_key.pt')}")

    if os.path.exists(onnx_path):
        dest_onnx = os.path.join(output_dir, "yolov8n_key.onnx")
        shutil.copy(onnx_path, dest_onnx)
        print(f"Saved ONNX weights:    {dest_onnx}")

    print("\n" + "=" * 60)
    print("ALL DONE! Download 'yolov8n_key.pt' or 'yolov8n_key.onnx' from Kaggle.")
    print("=" * 60)


if __name__ == "__main__":
    train_key_detector()
