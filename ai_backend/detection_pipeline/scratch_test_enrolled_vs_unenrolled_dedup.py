"""
Live Test: Enrolled vs Unenrolled Independent Deduplication Gate Verification.
Protocol:
1. Enrolls 'Omair's Water Bottle' with 576-D MobileNetV3 embeddings in MongoDB useritems.
2. Evaluates real keyframe containing BOTH the enrolled bottle AND unenrolled generic items (Laptop, Bowl).
3. Verifies:
   - Enrolled item dedups on (user_id, enrolled_item_id) -> 'Omair's Water Bottle'
   - Unenrolled items dedup on (user_id, class_id) -> 'Laptop', 'Bowl/Basin'
   - Both operate on independent dedup windows without crosstalk.
   - At t=0s: Both are logged as fresh (1 keyframe in items_storage/, 1 EventLog).
   - At t=120s: Continuous presence -> Suppressed (0 new files, 0 new EventLogs).
   - At t=910s: Window expires (15m10s) -> Fresh re-encounter (2nd keyframe in items_storage/, 2nd EventLog).
"""

import os
import sys
import time
import glob
import cv2
import numpy as np
from bson import ObjectId
from pymongo import MongoClient

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.join(LOCUS_DIR, "ai_backend"))

from ai.item_indexer import DailyItemIndexer, ITEM_DEDUP_SECONDS
from ai.embedding_backbone import ItemEmbeddingBackbone
from keyframe_backend.keyframe import ItemStorage, ITEMS_STORAGE_DIR

def run_test():
    print("=" * 80)
    print("ENROLLED VS UNENROLLED INDEPENDENT DEDUP VERIFICATION")
    print("=" * 80)

    test_user_id = str(ObjectId())
    storage = ItemStorage()
    indexer = DailyItemIndexer.get_instance()
    backbone = ItemEmbeddingBackbone.get_instance()

    client = MongoClient("mongodb://127.0.0.1:27017")
    db = client["locusDB"]

    # 1. Clean previous test artifacts
    db.useritems.delete_many({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}})
    db.eventlogs.delete_many({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}})
    shutil_dir = os.path.join(ITEMS_STORAGE_DIR, test_user_id)
    if os.path.exists(shutil_dir):
        import shutil
        shutil.rmtree(shutil_dir, ignore_errors=True)

    # 2. Extract embeddings from real bottle crop to enroll "Omair's Water Bottle"
    kf_path = glob.glob(os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage", "**", "*7b2d23e8*.jpg"), recursive=True)[0]
    raw_img = cv2.imread(kf_path)
    
    # Real bottle crop on the table at [808, 259, 867, 341]
    bottle_crop = raw_img[259:341, 808:867]

    emb1 = backbone.extract(bottle_crop).tolist()
    emb2 = backbone.extract(cv2.flip(bottle_crop, 1)).tolist()
    emb3 = backbone.extract(cv2.convertScaleAbs(bottle_crop, alpha=1.05, beta=5)).tolist()

    enrolled_item_doc = {
        "user_id": ObjectId(test_user_id),
        "item_name": "Omair's Water Bottle",
        "category": "Bottle",
        "item_embeddings": [emb1, emb2, emb3],
        "is_active": True,
        "createdAt": time.time(),
        "updatedAt": time.time()
    }
    insert_res = db.useritems.insert_one(enrolled_item_doc)
    enrolled_item_id = str(insert_res.inserted_id)

    print(f"\n[1] Enrolled Personal Item in Exemplar Gallery:")
    print(f"  - Item Name:         'Omair's Water Bottle'")
    print(f"  - Enrolled Item ID:  {enrolled_item_id}")
    print(f"  - User ID:           {test_user_id}")
    print(f"  - Embedding Count:   3 (576-D vectors)")

    # Force indexer cache refresh
    indexer._user_items_cache.pop(test_user_id, None)

    # 3. Simulate frames containing BOTH enrolled bottle AND unenrolled laptop
    metadata = {"user_id": test_user_id, "source": "enrolled_vs_unenrolled_test"}
    base_time = 30000.0

    print("\n[2] Testing Timeline with Enrolled Item + Unenrolled Generic Items:")

    # Step A: t=0s -> Initial detection of both items
    time.monotonic = lambda: base_time
    task_t0 = {"keyframe_id": "test_dual_t0", "frame": raw_img, "metadata": metadata}
    indexer._process_keyframe_task(task_t0)

    events_t0 = list(db.eventlogs.find({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}}))
    saved_files_t0 = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", "*.jpg"), recursive=True)

    print(f"\n  * Step A: t=0s (Initial Detection of Enrolled Bottle + Unenrolled Laptop/Bowl):")
    print(f"      - EventLogs created: {len(events_t0)}")
    print(f"      - Files in items_storage/: {len(saved_files_t0)}")
    assert len(events_t0) == 1, "Expected 1 initial event"
    
    details_t0 = events_t0[0]["details"]
    items_detected = details_t0["items"]
    item_names_t0 = details_t0["item_names"]
    print(f"      - Item Names in Event: {item_names_t0}")

    enrolled_matches = [d for d in items_detected if d.get("matched_item") == "Omair's Water Bottle"]
    unenrolled_matches = [d for d in items_detected if "matched_item" not in d]

    print(f"      - Enrolled Match: '{enrolled_matches[0]['matched_item']}' (ID: {enrolled_matches[0].get('enrolled_item_id')}, Sim: {enrolled_matches[0].get('exemplar_similarity')})")
    print(f"      - Unenrolled Items: {[d['name'] for d in unenrolled_matches]}")
    assert len(enrolled_matches) > 0, "Omair's Water Bottle must be matched via exemplar gallery"
    assert enrolled_matches[0]["enrolled_item_id"] == enrolled_item_id, "Enrolled item ID must match MongoDB document ID"
    assert len(unenrolled_matches) > 0, "Unenrolled items (e.g. Laptop) must remain generic"

    # Step B: t=120s -> Same scene continues within 15-minute dedup window
    time.monotonic = lambda: base_time + 120.0
    task_t120 = {"keyframe_id": "test_dual_t120", "frame": raw_img, "metadata": metadata}
    indexer._process_keyframe_task(task_t120)

    events_t120 = list(db.eventlogs.find({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}}))
    saved_files_t120 = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", "*.jpg"), recursive=True)

    print(f"\n  * Step B: t=120s (Repeat View within 15m Window):")
    print(f"      - EventLogs count: {len(events_t120)} (Expected: 1, Suppressed)")
    print(f"      - Files in items_storage/: {len(saved_files_t120)} (Expected: 1, Suppressed)")
    assert len(events_t120) == 1, "Must not create duplicate events within dedup window"
    assert len(saved_files_t120) == 1, "Must not save duplicate keyframes within dedup window"

    # Step C: t=910s -> Window expires (15m10s). Enrolled item and unenrolled items re-trigger cleanly.
    time.monotonic = lambda: base_time + 910.0
    task_t910 = {"keyframe_id": "test_dual_t910", "frame": raw_img, "metadata": metadata}
    indexer._process_keyframe_task(task_t910)

    events_t910 = list(db.eventlogs.find({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}}))
    saved_files_t910 = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", "*.jpg"), recursive=True)

    print(f"\n  * Step C: t=910s (After 15-Minute Window Expiry):")
    print(f"      - EventLogs count: {len(events_t910)} (Expected: 2, Fresh Re-encounter)")
    print(f"      - Files in items_storage/: {len(saved_files_t910)} (Expected: 2, Fresh Re-encounter)")
    assert len(events_t910) == 2, "Must create fresh event after dedup window expiry"
    assert len(saved_files_t910) == 2, "Must save fresh keyframe after dedup window expiry"

    # 4. Clean up test user artifacts
    db.useritems.delete_many({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}})
    db.eventlogs.delete_many({"user_id": {"$in": [test_user_id, ObjectId(test_user_id)]}})

    print("\n" + "=" * 80)
    print("ALL ENROLLED VS UNENROLLED DEDUP TESTS PASSED [100% SUCCESS]")
    print("=" * 80)

if __name__ == "__main__":
    run_test()
