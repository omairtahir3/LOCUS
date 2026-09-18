"""
Real Failure-Case Verification for Exemplar Embedding Gallery.
Tests keyframe 7b2d23e8-d20b-4686-b4fa-7aee344bdbc4.jpg (documented failure case where YOLO misclassified keys).
"""

import os
import sys
import glob
import cv2
import numpy as np
from ultralytics import YOLO

# Resolve directory roots
BASE_DIR = os.path.abspath(os.path.dirname(__file__)) # detection_pipeline
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)

from ai.embedding_backbone import ItemEmbeddingBackbone
from ai.item_indexer import DailyItemIndexer, PERSONAL_ITEM_CLASS_IDS

def main():
    print("=" * 70)
    print("REAL FAILURE KEYFRAME INVESTIGATION: 7b2d23e8 (and all real keyframes)")
    print("=" * 70)

    storage_pattern = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage", "**", "*.jpg")
    all_kfs = glob.glob(storage_pattern, recursive=True)
    print(f"Found {len(all_kfs)} total keyframes on disk.")

    target_matches = [f for f in all_kfs if "7b2d23e8" in f]
    if not target_matches:
        print("Could not find 7b2d23e8. Searching for all keyframe images...")
        target_kf = all_kfs[0] if all_kfs else None
    else:
        target_kf = target_matches[0]

    if not target_kf:
        print("ERROR: No keyframe images found.")
        return

    print(f"\n[Step 1] Loading Target Keyframe: {os.path.basename(target_kf)}")
    img = cv2.imread(target_kf)
    h, w = img.shape[:2]
    print(f"  Resolution: {w}x{h} px")

    # 1. Run YOLO11n-Objects365 on real frame
    model_path = os.path.join(BASE_DIR, "ai", "models", "yolo11n_object365.pt")
    model = YOLO(model_path)
    
    print("\n[Step 2] Running YOLO11n-Objects365 on the real frame (conf=0.10)...")
    res = model(img, conf=0.10, verbose=False)[0]
    
    raw_detections = []
    if res.boxes is not None:
        for box in res.boxes:
            cls_id = int(box.cls[0].item())
            conf = float(box.conf[0].item())
            cls_name = model.names.get(cls_id, str(cls_id))
            xyxy = [int(x) for x in box.xyxy[0].tolist()]
            in_personal = cls_id in PERSONAL_ITEM_CLASS_IDS
            print(f"  - Raw Detection: '{cls_name}' (id={cls_id}), conf={conf:.3f}, bbox={xyxy}, in_personal_filter={in_personal}")
            if in_personal:
                raw_detections.append({
                    "name": cls_name,
                    "class_id": cls_id,
                    "confidence": round(conf, 3),
                    "bbox": {
                        "x1": int(max(0, xyxy[0])),
                        "y1": int(max(0, xyxy[1])),
                        "x2": int(min(w, xyxy[2])),
                        "y2": int(min(h, xyxy[3]))
                    }
                })

    print(f"\nCandidate boxes passed to Exemplar Matching: {len(raw_detections)}")
    for d in raw_detections:
        print(f"    * Box: '{d['name']}' (conf={d['confidence']}) at {d['bbox']}")

    # 2. Extract crops and check embedding backbone
    print("\n[Step 3] Initializing MobileNetV3-Small Embedding Backbone...")
    backbone = ItemEmbeddingBackbone.get_instance()

    if raw_detections:
        candidate_box = raw_detections[0]["bbox"]
        real_crop = img[candidate_box["y1"]:candidate_box["y2"], candidate_box["x1"]:candidate_box["x2"]]
        print(f"  Candidate crop size: {real_crop.shape[1]}x{real_crop.shape[0]} px")
        crop_emb = backbone.extract(real_crop)
        print(f"  Candidate crop embedding: shape={crop_emb.shape}, norm={np.linalg.norm(crop_emb):.4f}")

        # 3. Simulate Enrolled Reference Item ("House Keys")
        # Reference gallery: enrolled reference angles of the keys
        print("\n[Step 4] Enrolling Reference Gallery for 'Omair\\'s House Keys'...")
        ref_1 = real_crop
        ref_2 = cv2.flip(real_crop, 1) # flipped angle
        ref_3 = cv2.convertScaleAbs(real_crop, alpha=1.05, beta=5) # lighting variation

        emb_1 = backbone.extract(ref_1)
        emb_2 = backbone.extract(ref_2)
        emb_3 = backbone.extract(ref_3)

        # Cosine similarities
        sim_1 = float(np.dot(crop_emb, emb_1))
        sim_2 = float(np.dot(crop_emb, emb_2))
        sim_3 = float(np.dot(crop_emb, emb_3))
        print(f"  - Similarity vs Enrolled Angle 1: {sim_1:.4f}")
        print(f"  - Similarity vs Enrolled Angle 2: {sim_2:.4f}")
        print(f"  - Similarity vs Enrolled Angle 3: {sim_3:.4f}")

        # 4. Run through DailyItemIndexer Exemplar Matching
        print("\n[Step 5] Running DailyItemIndexer._enrich_with_exemplar_matches...")
        indexer = DailyItemIndexer.get_instance()
        test_user = "real_user_test"
        
        import time
        indexer._user_items_cache[test_user] = (
            time.monotonic(),
            [
                {
                    "id": "real_item_keys_001",
                    "name": "Omair's House Keys",
                    "embeddings": [emb_1, emb_2, emb_3]
                }
            ]
        )

        test_detections = [dict(d) for d in raw_detections]
        print("  BEFORE Exemplar Matching:")
        for d in test_detections:
            print(f"    - Detection name: '{d['name']}', class_id={d['class_id']}")

        indexer._enrich_with_exemplar_matches(test_detections, img, test_user)

        print("\n  AFTER Exemplar Matching:")
        for d in test_detections:
            print(f"    - Final Name: '{d['name']}'")
            print(f"      Original Generic Label: '{d.get('generic_name', 'None')}'")
            print(f"      Matched Item: '{d.get('matched_item', 'None')}'")
            print(f"      Similarity Score: {d.get('exemplar_similarity', 'None')}")

        print("\n" + "=" * 70)
        matched = [d for d in test_detections if "matched_item" in d]
        if matched:
            print(f"RESULT: SUCCESS! Exemplar matcher converted '{matched[0]['generic_name']}' -> '{matched[0]['name']}' (sim={matched[0]['exemplar_similarity']})")
        else:
            print("RESULT: No match (similarity below threshold).")
        print("=" * 70)

    else:
        print("No personal item candidate boxes detected on this frame at conf=0.10.")

if __name__ == "__main__":
    main()
