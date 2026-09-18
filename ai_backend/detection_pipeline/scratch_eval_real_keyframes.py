import os
import glob
import cv2
import numpy as np
from ultralytics import YOLO

# Add detection_pipeline to path
import sys
sys.path.insert(0, "ai_backend/detection_pipeline")

from ai.embedding_backbone import ItemEmbeddingBackbone
from ai.item_indexer import DailyItemIndexer, PERSONAL_ITEM_CLASS_IDS

MODEL_O365_PATH = "ai_backend/detection_pipeline/ai/models/yolo11n_object365.pt"
model = YOLO(MODEL_O365_PATH)

print("=" * 60)
print("REAL FRAME INVESTIGATION & EXEMPLAR MATCHING EVALUATION")
print("=" * 60)

kf_images = sorted(glob.glob("ai_backend/keyframe_backend/keyframe_storage/**/*.jpg", recursive=True))
print(f"Total keyframes found: {len(kf_images)}")

# Check keyframe 7b2d23e8
target_kf = [f for f in kf_images if "7b2d23e8" in f]
if target_kf:
    kf_path = target_kf[0]
    print(f"\n[1] Examining Target Failure Keyframe: {os.path.basename(kf_path)}")
    img = cv2.imread(kf_path)
    h, w = img.shape[:2]
    
    # Run YOLO11n-Objects365 at conf=0.15
    res = model(img, conf=0.15, verbose=False)[0]
    boxes = res.boxes
    
    print(f"  Image size: {w}x{h}")
    print(f"  Total raw boxes detected: {len(boxes) if boxes is not None else 0}")
    
    raw_detections = []
    if boxes is not None:
        for box in boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            name = model.names.get(cls_id, str(cls_id))
            xyxy = box.xyxy[0].tolist()
            in_personal = cls_id in PERSONAL_ITEM_CLASS_IDS
            print(f"    - Raw Detection: '{name}' (class_id={cls_id}) conf={conf:.3f}, in_personal_list={in_personal}, xyxy={[int(x) for x in xyxy]}")
            if in_personal:
                raw_detections.append({
                    "name": name,
                    "class_id": cls_id,
                    "confidence": round(conf, 3),
                    "bbox": {
                        "x1": int(max(0, xyxy[0])),
                        "y1": int(max(0, xyxy[1])),
                        "x2": int(min(w, xyxy[2])),
                        "y2": int(min(h, xyxy[3]))
                    }
                })

    print(f"\n  Passed to DailyItemIndexer: {len(raw_detections)} candidate detections")

    # Let's inspect all 56 frames to find which ones have detections
    print("\n[2] Scanning all 56 real keyframes for candidate bounding boxes:")
    frames_with_detections = []
    for f in kf_images:
        im = cv2.imread(f)
        if im is None: continue
        r = model(im, conf=0.20, verbose=False)[0]
        if r.boxes is not None and len(r.boxes) > 0:
            det_summary = []
            for b in r.boxes:
                cid = int(b.cls[0].item())
                if cid in PERSONAL_ITEM_CLASS_IDS:
                    cname = model.names.get(cid, str(cid))
                    cconf = float(b.conf[0].item())
                    det_summary.append(f"{cname}({cconf:.2f})")
            if det_summary:
                frames_with_detections.append((os.path.basename(f), det_summary))

    print(f"  Frames with personal item bounding boxes: {len(frames_with_detections)} / {len(kf_images)}")
    for fname, dets in frames_with_detections[:15]:
        print(f"    - {fname}: {', '.join(dets)}")

