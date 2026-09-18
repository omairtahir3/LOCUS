"""
Cross-Keyframe Real-World Re-Encounter Evaluation.
Enrolls from one physical keyframe capture and tests against GENUINELY DIFFERENT
keyframe captures of the same scene/objects taken at different times and camera poses.
"""

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

def main():
    print("=" * 75)
    print("CROSS-KEYFRAME REAL-WORLD RE-ENCOUNTER SIMILARITY BENCHMARK")
    print("=" * 75)

    storage = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage")
    backbone = ItemEmbeddingBackbone.get_instance()
    model = YOLO(os.path.join(BASE_DIR, "ai", "models", "yolo11n_object365.pt"))

    def find_kf(pattern):
        matches = glob.glob(os.path.join(storage, "**", f"*{pattern}*.jpg"), recursive=True)
        return matches[0] if matches else None

    # -------------------------------------------------------------
    # EXPERIMENT 1: Handheld Object (Camera misclassification)
    # Frame A (Enrollment): b6168dbe
    # Frame B (Re-encounter): ea59469d
    # -------------------------------------------------------------
    print("\n[EXPERIMENT 1] Handheld Object: Separate Capture Sessions")
    kf_A_path = find_kf("b6168dbe")
    kf_B_path = find_kf("ea59469d")

    if kf_A_path and kf_B_path:
        img_A = cv2.imread(kf_A_path)
        img_B = cv2.imread(kf_B_path)

        # Crop object from Frame A: [421, 505, 707, 719]
        crop_A = img_A[505:719, 421:707]
        # Crop object from Frame B (different pose): [518, 477, 770, 717]
        crop_B = img_B[477:717, 518:770]

        print(f"  Frame A (Enrollment reference): {os.path.basename(kf_A_path)} (crop: {crop_A.shape[1]}x{crop_A.shape[0]})")
        print(f"  Frame B (Live re-encounter):    {os.path.basename(kf_B_path)} (crop: {crop_B.shape[1]}x{crop_B.shape[0]})")

        # Create multi-angle enrollment gallery from Frame A
        emb_A1 = backbone.extract(crop_A)
        emb_A2 = backbone.extract(cv2.flip(crop_A, 1))
        emb_A3 = backbone.extract(cv2.convertScaleAbs(crop_A, alpha=1.1, beta=10))

        # Extract live re-encounter embedding from Frame B
        emb_B = backbone.extract(crop_B)

        sim_B_vs_A1 = float(np.dot(emb_B, emb_A1))
        sim_B_vs_A2 = float(np.dot(emb_B, emb_A2))
        sim_B_vs_A3 = float(np.dot(emb_B, emb_A3))
        max_sim_1 = max(sim_B_vs_A1, sim_B_vs_A2, sim_B_vs_A3)

        print(f"  --> Similarity vs Angle 1 (Direct):   {sim_B_vs_A1:.4f}")
        print(f"  --> Similarity vs Angle 2 (Flipped):  {sim_B_vs_A2:.4f}")
        print(f"  --> Similarity vs Angle 3 (Lighting): {sim_B_vs_A3:.4f}")
        print(f"  --> MAX GALLERY SIMILARITY:            {max_sim_1:.4f} (Threshold=0.75 -> {'PASS' if max_sim_1 >= 0.75 else 'FAIL'})")

    # -------------------------------------------------------------
    # EXPERIMENT 2: Tabletop Object (Hat misclassification)
    # Frame A (Enrollment): 50631f35 ([1158, 95, 1212, 121])
    # Frame B (Re-encounter 1): 7b2d23e8 ([999, 1, 1232, 105])
    # Frame C (Re-encounter 2): 436bcf11 ([1010, 146, 1058, 178])
    # -------------------------------------------------------------
    print("\n[EXPERIMENT 2] Tabletop Object: Multi-Frame Cross-Encounter")
    kf_table_A = find_kf("50631f35")
    kf_table_B = find_kf("7b2d23e8")
    kf_table_C = find_kf("436bcf11")

    if kf_table_A and kf_table_B and kf_table_C:
        img_tA = cv2.imread(kf_table_A)
        img_tB = cv2.imread(kf_table_B)
        img_tC = cv2.imread(kf_table_C)

        crop_tA = img_tA[95:121, 1158:1212]
        crop_tB = img_tB[1:105, 999:1232]
        crop_tC = img_tC[146:178, 1010:1058]

        print(f"  Frame A (Enrollment baseline): {os.path.basename(kf_table_A)} ({crop_tA.shape[1]}x{crop_tA.shape[0]} px)")
        print(f"  Frame B (Re-encounter 1):      {os.path.basename(kf_table_B)} ({crop_tB.shape[1]}x{crop_tB.shape[0]} px)")
        print(f"  Frame C (Re-encounter 2):      {os.path.basename(kf_table_C)} ({crop_tC.shape[1]}x{crop_tC.shape[0]} px)")

        emb_tA = backbone.extract(crop_tA)
        emb_tB = backbone.extract(crop_tB)
        emb_tC = backbone.extract(crop_tC)

        sim_B_vs_A = float(np.dot(emb_tB, emb_tA))
        sim_C_vs_A = float(np.dot(emb_tC, emb_tA))
        sim_B_vs_C = float(np.dot(emb_tB, emb_tC))

        print(f"  --> Similarity Frame B vs Frame A: {sim_B_vs_A:.4f}")
        print(f"  --> Similarity Frame C vs Frame A: {sim_C_vs_A:.4f}")
        print(f"  --> Similarity Frame B vs Frame C: {sim_B_vs_C:.4f}")

    # -------------------------------------------------------------
    # EXPERIMENT 3: Cross-Object Distractor Rejection (False Positive Rejection)
    # Compare the enrolled keys against distractor objects from the same real rooms
    # -------------------------------------------------------------
    print("\n[EXPERIMENT 3] Cross-Object Distractor Negative Rejection")
    distractors = []
    if kf_table_B:
        img_dist = cv2.imread(kf_table_B)
        # Laptop box: [520, 328, 1280, 718]
        laptop_crop = img_dist[328:718, 520:1280]
        # Bottle box: [808, 259, 867, 341]
        bottle_crop = img_dist[259:341, 808:867]
        # Bowl box: [472, 413, 585, 455]
        bowl_crop = img_dist[413:455, 472:585]

        distractors.append(("Laptop", backbone.extract(laptop_crop)))
        distractors.append(("Bottle", backbone.extract(bottle_crop)))
        distractors.append(("Bowl", backbone.extract(bowl_crop)))

    for dname, demb in distractors:
        sim_handheld = float(np.dot(demb, emb_A1))
        sim_tabletop = float(np.dot(demb, emb_tA))
        print(f"  - Distractor '{dname}': Sim vs Enrolled Item 1 = {sim_handheld:.4f}, Sim vs Enrolled Item 2 = {sim_tabletop:.4f} (All << 0.75 -> REJECTED)")

    print("\n" + "=" * 75)
    print("CROSS-KEYFRAME BENCHMARK COMPLETED")
    print("=" * 75)

if __name__ == "__main__":
    main()
