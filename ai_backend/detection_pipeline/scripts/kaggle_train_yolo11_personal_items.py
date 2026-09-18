#!/usr/bin/env python3
"""
LOCUS Kaggle Fine-Tuning Workflow for Multi-Class Egocentric Personal Belongings.

Trains YOLO11 Nano (yolo11n.pt) on your custom egocentric dataset covering
the personal belongings you recorded (e.g. keys, wallet, phone, watch, glasses, mug, etc.).

Instructions for Kaggle GPU Notebook (T4 / P100):
1. Create a new Kaggle Notebook with GPU enabled (Settings -> Accelerator -> GPU T4 x2 or P100).
2. Upload your labeled Roboflow/YOLO dataset zip (contains 'dataset.yaml', 'images/', 'labels/').
3. Copy/paste and run this script.
4. Download the generated 'yolo11n_personal_items.pt' and 'yolo11n_personal_items.onnx'.
"""

import os
import shutil

# Step 1: Install Ultralytics and ONNX dependencies
# In Kaggle Notebook: !pip install ultralytics onnx onnxruntime

def train_personal_belongings_detector():
    from ultralytics import YOLO

    print("=" * 65)
    print("LOCUS YOLO11n PERSONAL BELONGINGS DETECTOR FINE-TUNING")
    print("=" * 65)

    # 1. Locate dataset.yaml
    # Checks standard Kaggle input directories or local working directory
    possible_paths = [
        "/kaggle/input/personal-items-dataset/dataset.yaml",
        "/kaggle/input/key-dataset/dataset.yaml",
        "/kaggle/input/locus-dataset/dataset.yaml",
        "dataset.yaml"
    ]
    
    dataset_yaml = None
    for p in possible_paths:
        if os.path.exists(p):
            dataset_yaml = p
            break
            
    if not dataset_yaml:
        # Search recursively
        import glob
        matches = glob.glob("/kaggle/input/**/dataset.yaml", recursive=True)
        dataset_yaml = matches[0] if matches else "dataset.yaml"

    print(f"Using dataset config: {dataset_yaml}")

    # 2. Load pre-trained YOLO11 Nano model
    # yolo11n.pt contains pre-trained edge/texture/color representations
    model = YOLO("yolo11n.pt")

    # 3. Train on personal belongings
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
        degrees=10.0,           # Slight head/chest tilt
        translate=0.1,          # Natural hand translation
        scale=0.5,              # Scale variation (held close vs on desk)
        shear=2.0,
        perspective=0.0005,
        flipud=0.0,             # Chest view is never upside down
        fliplr=0.5,             # Left/right hand symmetry
        hsv_h=0.015,            # Color hue tolerance
        hsv_s=0.7,              # Saturation tolerance (indoor lighting)
        hsv_v=0.4,              # Shadow & glare tolerance
        mosaic=1.0,             # Background scene mixing
        mixup=0.1,
        project="locus_training",
        name="yolo11n_personal_items_exp"
    )

    print("\n" + "=" * 65)
    print("TRAINING FINISHED. VALIDATING MODEL...")
    print("=" * 65)

    # 4. Evaluate metrics
    metrics = model.val()
    print(f"mAP50:    {metrics.box.map50:.4f}")
    print(f"mAP50-95: {metrics.box.map:.4f}")

    # 5. Export to ONNX for edge inference
    print("\n" + "=" * 65)
    print("EXPORTING MODEL TO ONNX...")
    print("=" * 65)

    onnx_path = model.export(
        format="onnx",
        dynamic=True,           # Support dynamic batching/resolution
        opset=17,
        simplify=True
    )
    print(f"ONNX Model Exported to: {onnx_path}")

    # 6. Copy artifacts to Kaggle working output directory
    output_dir = "/kaggle/working"
    best_pt = os.path.join("locus_training", "yolo11n_personal_items_exp", "weights", "best.pt")
    if os.path.exists(best_pt):
        dest_pt = os.path.join(output_dir, "yolo11n_personal_items.pt")
        shutil.copy(best_pt, dest_pt)
        print(f"Saved PyTorch weights: {dest_pt}")

    if os.path.exists(onnx_path):
        dest_onnx = os.path.join(output_dir, "yolo11n_personal_items.onnx")
        shutil.copy(onnx_path, dest_onnx)
        print(f"Saved ONNX weights:    {dest_onnx}")

    print("\n" + "=" * 65)
    print("ALL DONE! Download 'yolo11n_personal_items.pt' or 'yolo11n_personal_items.onnx' from Kaggle.")
    print("=" * 65)


if __name__ == "__main__":
    train_personal_belongings_detector()
