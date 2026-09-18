"""
End-to-end verification script for Exemplar Embedding Gallery.
Tests:
1. MobileNetV3-Small embedding extraction via ItemEmbeddingBackbone.
2. Exemplar matching in DailyItemIndexer (renaming generic detections to user custom names).
3. Cosine similarity thresholding and multi-angle matching.
4. Negative rejection for unrelated items.
"""

import os
import sys
import base64
import numpy as np
import cv2

# Add detection_pipeline to sys.path
PIPELINE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", "ai_backend", "detection_pipeline"))
sys.path.insert(0, PIPELINE_DIR)

from ai.embedding_backbone import ItemEmbeddingBackbone
from ai.item_indexer import DailyItemIndexer

def run_test():
    print("=" * 60)
    print("STARTING EXEMPLAR EMBEDDING GALLERY VERIFICATION")
    print("=" * 60)

    # 1. Test Backbone Extraction
    print("\n[Step 1] Initializing MobileNetV3-Small Backbone...")
    backbone = ItemEmbeddingBackbone.get_instance()
    
    # Create 3 synthetic sample angle images for a "Custom Red Keyring"
    img1 = np.full((224, 224, 3), (30, 30, 200), dtype=np.uint8) # Red background
    cv2.circle(img1, (112, 112), 50, (200, 200, 200), -1)        # Silver ring in center
    cv2.rectangle(img1, (100, 112), (124, 180), (200, 200, 200), -1) # Key shaft

    img2 = np.full((224, 224, 3), (35, 25, 190), dtype=np.uint8) # Slightly rotated / perturbed angle
    cv2.circle(img2, (115, 110), 48, (210, 210, 210), -1)
    cv2.rectangle(img2, (105, 110), (125, 175), (210, 210, 210), -1)

    img3 = np.full((224, 224, 3), (25, 35, 210), dtype=np.uint8) # Third angle
    cv2.circle(img3, (110, 115), 52, (190, 190, 190), -1)
    cv2.rectangle(img3, (98, 115), (122, 185), (190, 190, 190), -1)

    emb1 = backbone.extract(img1)
    emb2 = backbone.extract(img2)
    emb3 = backbone.extract(img3)

    print(f"  - Extracted 3 exemplar embeddings: shape={emb1.shape}, norm={np.linalg.norm(emb1):.4f}")
    assert emb1.shape == (576,), "Embedding dimension must be 576"
    assert abs(np.linalg.norm(emb1) - 1.0) < 1e-4, "Embedding must be L2 normalized"

    # Check cosine similarity between angles of the same item
    sim_1_2 = float(np.dot(emb1, emb2))
    sim_1_3 = float(np.dot(emb1, emb3))
    print(f"  - Multi-angle self-similarity: Angle 1 vs 2 = {sim_1_2:.4f}, Angle 1 vs 3 = {sim_1_3:.4f}")
    assert sim_1_2 > 0.85, "Same object angles should have high similarity"

    # Batch extraction test
    batch_embs = backbone.extract_batch([img1, img2, img3])
    assert len(batch_embs) == 3
    assert np.allclose(batch_embs[0], emb1, atol=1e-5), "Batch extract must match single extract"
    print("  - Batch embedding extraction verified (3 crops)")

    # 2. Test Exemplar Matching in DailyItemIndexer
    print("\n[Step 2] Testing DailyItemIndexer Exemplar Matching...")
    indexer = DailyItemIndexer.get_instance()
    
    test_user_id = "test_user_omair_123"
    test_item_name = "Omair's Red House Keys"

    # Populate cache directly with enrolled exemplar embeddings
    enrolled_items = [
        {
            "id": "item_key_001",
            "name": test_item_name,
            "embeddings": [emb1, emb2, emb3]
        }
    ]
    # Set cache with long TTL
    import time
    indexer._user_items_cache[test_user_id] = (time.monotonic(), enrolled_items)

    # Create a synthetic full camera frame (640x480) with the test item in lower quadrant
    frame = np.full((480, 640, 3), (120, 120, 120), dtype=np.uint8)
    resized_item = cv2.resize(img2, (120, 120))
    frame[250:370, 260:380] = resized_item

    # Simulated YOLO detection bbox
    test_detections = [
        {
            "name": "Key",
            "class_id": 999, # generic class
            "confidence": 0.88,
            "bbox": {
                "x1": 260,
                "y1": 250,
                "x2": 380,
                "y2": 370
            }
        }
    ]

    print(f"  - Initial detection before exemplar matching: {test_detections[0]['name']}")
    indexer._enrich_with_exemplar_matches(test_detections, frame, test_user_id)
    print(f"  - Detection after exemplar matching: {test_detections[0]['name']}")
    print(f"  - Matched Item: {test_detections[0].get('matched_item')}")
    print(f"  - Generic Class: {test_detections[0].get('generic_name')}")
    print(f"  - Similarity Score: {test_detections[0].get('exemplar_similarity')}")

    assert test_detections[0]["name"] == test_item_name, f"Expected '{test_item_name}', got '{test_detections[0]['name']}'"
    assert test_detections[0]["exemplar_similarity"] >= indexer.EXEMPLAR_MATCH_THRESHOLD, "Similarity must exceed threshold"
    assert test_detections[0]["generic_name"] == "Key"

    # 3. Test Negative Case (Different Object Should NOT Match)
    print("\n[Step 3] Testing Negative Case (Unrelated Object)...")
    unrelated_img = np.full((480, 640, 3), (255, 255, 255), dtype=np.uint8)
    cv2.rectangle(unrelated_img, (250, 250), (370, 370), (0, 200, 0), -1) # Solid green box

    negative_detections = [
        {
            "name": "Bottle",
            "class_id": 44,
            "confidence": 0.75,
            "bbox": {"x1": 250, "y1": 250, "x2": 370, "y2": 370}
        }
    ]
    indexer._enrich_with_exemplar_matches(negative_detections, unrelated_img, test_user_id)
    print(f"  - Negative detection name: {negative_detections[0]['name']}")
    assert "matched_item" not in negative_detections[0], "Unrelated object must NOT match enrolled item"
    assert negative_detections[0]["name"] == "Bottle", "Generic label must remain unchanged"

    print("\n" + "=" * 60)
    print("ALL EXEMPLAR EMBEDDING GALLERY TESTS PASSED SUCCESSFULLY! [OK]")
    print("=" * 60)

if __name__ == "__main__":
    run_test()
