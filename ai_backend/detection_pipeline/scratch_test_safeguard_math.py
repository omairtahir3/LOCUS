"""
Concrete Empirical Test of the Low-Texture Adaptive Safeguard.
Evaluates:
1. Phone (Low-texture case)
2. Bowl (Low-texture case)
3. Keys / Bottle (High-texture cases)

Measures:
- Internal Pairwise Gallery Similarity (mean_internal_sim)
- Triggering of 0.72 safeguard
- Behavior against top distractor vs true re-encounter
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

def evaluate_safeguard():
    print("=" * 80)
    print("CONCRETE EMPIRICAL TEST: LOW-TEXTURE SAFEGUARD BEHAVIOR")
    print("=" * 80)

    backbone = ItemEmbeddingBackbone.get_instance()
    storage = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage")

    def find_kf(pattern):
        matches = glob.glob(os.path.join(storage, "**", f"*{pattern}*.jpg"), recursive=True)
        return matches[0] if matches else None

    # Helper to compute internal pairwise similarity
    def compute_internal_sim(embs):
        pairwise = [
            float(np.dot(embs[i], embs[j]))
            for i in range(len(embs))
            for j in range(i + 1, len(embs))
        ]
        return sum(pairwise) / len(pairwise) if pairwise else 1.0

    cases = []

    # CASE 1: PHONE (Low-texture plain dark rectangle)
    kf_p1 = find_kf("00912645")
    kf_p2 = find_kf("17d17a03")
    if kf_p1 and kf_p2:
        img_p1 = cv2.imread(kf_p1)
        img_p2 = cv2.imread(kf_p2)
        crop_p1 = img_p1[0:195, 0:139] # Phone crop
        crop_p2 = img_p2[0:241, 0:279] # Re-encounter
        # Top distractor (Person dark clothing / shadow)
        crop_p_dist = img_p2[200:400, 200:400]

        cases.append(("Cell Phone (Plain)", crop_p1, crop_p2, crop_p_dist, "Person Shadow"))

    # CASE 2: BOWL (Low-texture plain ceramic bowl)
    kf_b1 = find_kf("47863b18")
    kf_b2 = find_kf("47dd5678")
    if kf_b1 and kf_b2:
        img_b1 = cv2.imread(kf_b1)
        img_b2 = cv2.imread(kf_b2)
        crop_b1 = img_b1[0:98, 0:157]
        crop_b2 = img_b2[0:236, 0:574]
        # Distractor (White bottle base)
        crop_b_dist = img_b1[100:200, 100:200]

        cases.append(("Ceramic Bowl (Plain)", crop_b1, crop_b2, crop_b_dist, "White Clutter"))

    # CASE 3: BOTTLE / KEYS (High-texture contoured items)
    kf_k1 = find_kf("b6168dbe")
    kf_k2 = find_kf("ea59469d")
    if kf_k1 and kf_k2:
        img_k1 = cv2.imread(kf_k1)
        img_k2 = cv2.imread(kf_k2)
        crop_k1 = img_k1[505:719, 421:707]
        crop_k2 = img_k2[477:717, 518:770]
        # Distractor (Laptop keyboard)
        crop_k_dist = img_k2[328:500, 520:800] if img_k2.shape[0] > 500 else img_k2[100:200, 100:200]

        cases.append(("Keys / Metal Keychain", crop_k1, crop_k2, crop_k_dist, "Laptop Clutter"))

    print(f"\n{'Item Category':<24} | {'Internal Sim':<12} | {'Safeguard':<10} | {'Distractor Sim':<14} | {'Distractor Rejected?'}")
    print("-" * 80)

    for name, c_enroll, c_live, c_dist, dist_name in cases:
        # Build 3-angle enrollment gallery
        e1 = backbone.extract(c_enroll)
        e2 = backbone.extract(cv2.flip(c_enroll, 1))
        e3 = backbone.extract(cv2.convertScaleAbs(c_enroll, alpha=1.1, beta=10))
        gallery = [e1, e2, e3]

        internal_sim = compute_internal_sim(gallery)
        is_low_texture = internal_sim >= 0.96
        applied_threshold = 0.72 if is_low_texture else 0.65

        # Distractor similarity (Max over gallery)
        e_dist = backbone.extract(c_dist)
        dist_sim = max(float(np.dot(e_dist, g)) for g in gallery)
        dist_rejected = dist_sim < applied_threshold

        # True live re-encounter similarity
        e_live = backbone.extract(c_live)
        live_sim = max(float(np.dot(e_live, g)) for g in gallery)
        live_matched = live_sim >= applied_threshold

        print(f"{name:<24} | {internal_sim:<12.4f} | {applied_threshold:<10.2f} | {dist_sim:<14.4f} | {str(dist_rejected):<10}")
        print(f"   -> Detail: Live True Match Sim = {live_sim:.4f} (Matched: {live_matched}) | Top Distractor = {dist_sim:.4f} (Rejected: {dist_rejected})")

    print("=" * 80)

if __name__ == "__main__":
    evaluate_safeguard()
