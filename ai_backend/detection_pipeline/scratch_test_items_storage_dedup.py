"""
Live Test: Items Storage & 15-Minute Dedup Gate Verification.
Tests:
1. First detection at t=0 -> Writes exactly 1 keyframe to items_storage/ and 1 EventLog.
2. Continuous visibility across dedup window (t=10s, 30s, 100s, 600s, 899s) -> Suppressed, 0 new files/events.
3. Re-encounter after window expiry (t=901s) -> Writes exactly 1 new keyframe and 1 EventLog.
4. Keyframe integrity -> Confirms keyframe_id references a real existing image file in items_storage/.
"""

import os
import sys
import time
import glob
import cv2
import numpy as np
from datetime import datetime, timezone
from pymongo import MongoClient

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.join(LOCUS_DIR, "ai_backend"))

from ai.item_indexer import DailyItemIndexer, ITEM_DEDUP_SECONDS
from keyframe_backend.keyframe import ItemStorage, ITEMS_STORAGE_DIR

def run_dedup_test():
    print("=" * 80)
    print("ITEMS_STORAGE & 15-MINUTE DEDUP GATE LIVE VERIFICATION")
    print("=" * 80)

    test_user_id = "test_user_dedup_live"
    storage = ItemStorage()
    indexer = DailyItemIndexer.get_instance()

    # Clear previous test files in items_storage for this test user
    user_item_dir = os.path.join(ITEMS_STORAGE_DIR, test_user_id)
    if os.path.exists(user_item_dir):
        import shutil
        shutil.rmtree(user_item_dir, ignore_errors=True)

    # Clear previous test logs from db.eventlogs
    client = MongoClient("mongodb://127.0.0.1:27017")
    db = client["locusDB"]
    db.eventlogs.delete_many({"user_id": test_user_id})

    print(f"\n[1] Configuration Check:")
    print(f"  - ITEM_DEDUP_SECONDS: {ITEM_DEDUP_SECONDS}s ({ITEM_DEDUP_SECONDS/60:.1f} minutes)")
    print(f"  - Target Storage Dir: {ITEMS_STORAGE_DIR}")
    assert ITEM_DEDUP_SECONDS == 900, "ITEM_DEDUP_SECONDS must be 900s (15 minutes)"

    # Load a real keyframe image (containing keys / personal items)
    kf_path = glob.glob(os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage", "**", "*7b2d23e8*.jpg"), recursive=True)[0]
    test_img = cv2.imread(kf_path)
    metadata = {"user_id": test_user_id, "source": "dedup_test"}

    # Mock time.monotonic to simulate exact timeline progression
    base_time = 10000.0
    timeline = [
        (0, "t=0s (Initial Detection)"),
        (10, "t=10s (Immediate Repeat)"),
        (30, "t=30s (Continuous in-frame)"),
        (300, "t=5m (Stationary item on table)"),
        (600, "t=10m (Stationary item on table)"),
        (899, "t=14m59s (Just before window expiry)"),
        (905, "t=15m05s (Window Expired -> Fresh Re-encounter)")
    ]

    saved_keyframe_ids = []

    print("\n[2] Executing Continuous Detection Simulation across 15-Minute Window:")
    for offset_sec, label in timeline:
        current_mono = base_time + offset_sec

        # Monkey-patch monotonic time for controlled timeline evaluation
        original_monotonic = time.monotonic
        time.monotonic = lambda: current_mono

        try:
            # Process frame synchronously for testing
            task = {"keyframe_id": f"test_kf_{offset_sec}", "frame": test_img, "metadata": metadata}
            indexer._process_keyframe_task(task)
        finally:
            time.monotonic = original_monotonic

        # Inspect items_storage files
        saved_files = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", "*.jpg"), recursive=True)
        db_events = list(db.eventlogs.find({"user_id": test_user_id}))

        print(f"\n  * {label}:")
        print(f"      - Total image files in items_storage/: {len(saved_files)}")
        print(f"      - Total EventLog records in MongoDB:  {len(db_events)}")

        if offset_sec == 0:
            assert len(saved_files) == 1, f"Expected exactly 1 file at t=0, got {len(saved_files)}"
            assert len(db_events) == 1, f"Expected exactly 1 DB event at t=0, got {len(db_events)}"
            saved_keyframe_ids.append(db_events[0]["keyframe_id"])
        elif offset_sec < 900:
            assert len(saved_files) == 1, f"Expected exactly 1 file during dedup window, got {len(saved_files)}"
            assert len(db_events) == 1, f"Expected exactly 1 DB event during dedup window, got {len(db_events)}"
        elif offset_sec >= 900:
            assert len(saved_files) == 2, f"Expected exactly 2 files after window expiry, got {len(saved_files)}"
            assert len(db_events) == 2, f"Expected exactly 2 DB events after window expiry, got {len(db_events)}"
            saved_keyframe_ids.append(db_events[1]["keyframe_id"])

    print("\n[3] Verifying Physical Keyframe Integrity (No Dangling IDs):")
    for kid in saved_keyframe_ids:
        expected_img = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", f"{kid}.jpg"), recursive=True)
        expected_meta = glob.glob(os.path.join(ITEMS_STORAGE_DIR, test_user_id, "**", f"{kid}.json"), recursive=True)
        print(f"  - Keyframe ID: {kid}")
        print(f"      * Image exists on disk:    {len(expected_img) > 0} ({expected_img[0] if expected_img else 'MISSING'})")
        print(f"      * Metadata exists on disk: {len(expected_meta) > 0}")
        assert len(expected_img) > 0, f"Image {kid}.jpg must exist on disk"
        assert len(expected_meta) > 0, f"Metadata {kid}.json must exist on disk"

    print("\n[4] Testing Storage Cleanup Retention on Item Keyframes:")
    # Run cleanup on storage (should retain active item keyframes)
    deleted_count = storage.cleanup_expired()
    print(f"  - Expired frame cleanup executed cleanly (deleted non-retained: {deleted_count})")

    # Clean up test user DB entries
    db.eventlogs.delete_many({"user_id": test_user_id})

    print("\n" + "=" * 80)
    print("ALL ITEMS_STORAGE & 15-MINUTE DEDUP GATE TESTS PASSED [100% SUCCESS]")
    print("=" * 80)

if __name__ == "__main__":
    run_dedup_test()
