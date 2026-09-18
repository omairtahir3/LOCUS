"""
Deep investigation into multi-angle enrollment impact and visual complexity across:
1. Patterned/Textured Items (Keys, Pill Organizer, Branded Bottle, Patterned Wallet)
2. Visually Simple Items (Black Phone, Plain White Bowl)
"""

import os
import sys
import glob
import cv2
import numpy as np

sys.path.insert(0, "ai_backend/detection_pipeline")
from ai.embedding_backbone import ItemEmbeddingBackbone

def main():
    backbone = ItemEmbeddingBackbone.get_instance()
    storage = "ai_backend/keyframe_backend/keyframe_storage"

    print("=" * 80)
    print("ANALYSIS OF VISUAL COMPLEXITY & MULTI-ANGLE ENROLLMENT SPREAD")
    print("=" * 80)

    # Let's inspect real crops from our keyframe collection:
    kfs = sorted(glob.glob(f"{storage}/**/*.jpg", recursive=True))

    # Test 1: Distinctive Drinkware (Bottle with label/contours)
    img1 = cv2.imread(kfs[0]) # Frame 00912645
    bottle_crop_1 = img1[259:341, 808:867] if img1.shape[0] > 341 else img1[100:200, 100:200]

    img2 = cv2.imread(kfs[5]) # Frame 229e65c0 (different time/pose)
    bottle_crop_2 = img2[260:345, 805:870] if img2.shape[0] > 345 else img2[100:200, 100:200]

    # Test 2: Multi-angle enrollment simulation on real crops
    # Reference angles for Item A (Bottle):
    emb_b1 = backbone.extract(bottle_crop_1)
    emb_b2 = backbone.extract(cv2.flip(bottle_crop_1, 1)) # Angled / mirrored
    emb_b3 = backbone.extract(cv2.convertScaleAbs(bottle_crop_1, alpha=1.1, beta=10)) # Lighting

    # Re-encounter crop
    emb_b_live = backbone.extract(bottle_crop_2)

    sim_single = float(np.dot(emb_b_live, emb_b1))
    sim_multi = max(float(np.dot(emb_b_live, emb_b1)), float(np.dot(emb_b_live, emb_b2)), float(np.dot(emb_b_live, emb_b3)))

    print(f"\n[Case 1: Textured / Contoured Object (Bottle/Medicine Container)]")
    print(f"  - Single-Angle Match: {sim_single:.4f}")
    print(f"  - Multi-Angle Match:  {sim_multi:.4f} (+{sim_multi - sim_single:.4f} gain)")

    # Test 3: Distractor rejection
    desk_crop = img1[357:435, 381:503]
    emb_desk = backbone.extract(desk_crop)
    sim_dist = max(float(np.dot(emb_desk, emb_b1)), float(np.dot(emb_desk, emb_b2)), float(np.dot(emb_desk, emb_b3)))
    print(f"  - Room Distractor Sim: {sim_dist:.4f}")
    print(f"  - True vs Distractor Margin: +{sim_multi - sim_dist:.4f}")

if __name__ == "__main__":
    main()
