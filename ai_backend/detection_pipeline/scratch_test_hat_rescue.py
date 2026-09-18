import os
import sys
import glob
import cv2
import numpy as np
from ultralytics import YOLO

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)

from ai.embedding_backbone import ItemEmbeddingBackbone
from ai.item_indexer import DailyItemIndexer, PERSONAL_ITEM_CLASS_IDS

def test_hat_misclassification():
    kf_path = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage", "6a6e439595ff22c2e2f91416", "2026-09-13", "7b2d23e8-d20b-4686-b4fa-7aee344bdbc4.jpg")
    img = cv2.imread(kf_path)
    h, w = img.shape[:2]

    # Run YOLO11n-Objects365
    model = YOLO(os.path.join(BASE_DIR, "ai", "models", "yolo11n_object365.pt"))
    res = model(img, conf=0.10, verbose=False)[0]

    detections = []
    for box in res.boxes:
        cls_id = int(box.cls[0].item())
        conf = float(box.conf[0].item())
        cls_name = model.names.get(cls_id, str(cls_id))
        xyxy = [int(x) for x in box.xyxy[0].tolist()]
        if cls_id in PERSONAL_ITEM_CLASS_IDS:
            detections.append({
                "name": cls_name,
                "class_id": cls_id,
                "confidence": round(conf, 3),
                "bbox": {"x1": max(0, xyxy[0]), "y1": max(0, xyxy[1]), "x2": min(w, xyxy[2]), "y2": min(h, xyxy[3])}
            })

    print(f"Total personal-category detections: {len(detections)}")
    for i, d in enumerate(detections):
        print(f"  [{i}] '{d['name']}' (conf={d['confidence']}) at {d['bbox']}")

    # Find the Hat detection
    hat_idx = [i for i, d in enumerate(detections) if d["name"] == "Hat"][0]
    hat_det = detections[hat_idx]
    hat_box = hat_det["bbox"]
    hat_crop = img[hat_box["y1"]:hat_box["y2"], hat_box["x1"]:hat_box["x2"]]

    backbone = ItemEmbeddingBackbone.get_instance()
    hat_emb = backbone.extract(hat_crop)

    # Enroll "My Keys" using the physical object crop + multi-angle variants
    ref_1 = hat_crop
    ref_2 = cv2.flip(hat_crop, 1)
    ref_3 = cv2.convertScaleAbs(hat_crop, alpha=1.05, beta=5)

    emb_1 = backbone.extract(ref_1)
    emb_2 = backbone.extract(ref_2)
    emb_3 = backbone.extract(ref_3)

    indexer = DailyItemIndexer.get_instance()
    user_id = "test_user_hat_rescue"
    import time
    indexer._user_items_cache[user_id] = (
        time.monotonic(),
        [{
            "id": "item_keys_rescued",
            "name": "My Keys (Enrolled)",
            "embeddings": [emb_1, emb_2, emb_3]
        }]
    )

    print("\n--- BEFORE Exemplar Matching ---")
    for d in detections:
        print(f"  Item: '{d['name']}'")

    indexer._enrich_with_exemplar_matches(detections, img, user_id)

    print("\n--- AFTER Exemplar Matching ---")
    for d in detections:
        matched = d.get("matched_item")
        if matched:
            print(f"  >> RESCUED: Original='{d.get('generic_name')}' -> Custom='{d['name']}' (similarity={d.get('exemplar_similarity')})")
        else:
            print(f"     Unchanged: '{d['name']}'")

if __name__ == "__main__":
    test_hat_misclassification()
