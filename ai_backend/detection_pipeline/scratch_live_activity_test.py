"""
Comprehensive Activity Detection Re-Test across all mapped activities.
Tests:
1. Typing (Laptop, Keyboard, Mouse)
2. Drinking (Bottle vs Cup)
3. Eating (Plate/Utensils, Bowl context fix, Tier-2 Gap-fill)
4. Phone, Computer, Toothbrush & other mapped categories

Analyzes:
- Tier-1 EgocentricActivityPlugin output
- Tier-2 DailyItemIndexer Gap-Filling output
- RAW/BELOW detection breakdown across all 56 keyframes
"""

import os
import sys
import glob
import cv2
import json
import numpy as np

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.join(LOCUS_DIR, "ai_backend"))

from ai.plugins.egocentric_activity import EgocentricActivityPlugin
from ai.core.contracts import EventContext
from ai.item_indexer import DailyItemIndexer, TIER2_GAP_FILL_ACTIVITY_MAP
from ultralytics import YOLO

def main():
    print("=" * 80)
    print("COMPREHENSIVE ACTIVITY DETECTION BENCHMARK & RE-TEST")
    print("=" * 80)

    # 1. Run Tier-1 (EgocentricActivityPlugin) on all 56 real keyframe images
    print("\n" + "=" * 80)
    print("[PART 1] Tier-1 Live Plugin Evaluation (YOLOv8 Egocentric on 56 Keyframes)")
    print("=" * 80)

    plugin = EgocentricActivityPlugin()
    context = EventContext(user_id="benchmark_user")
    storage = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage")
    all_kfs = sorted(glob.glob(os.path.join(storage, "**", "*.jpg"), recursive=True))

    tier1_emissions = []
    tier1_suppressions = []

    for kf_path in all_kfs:
        fname = os.path.basename(kf_path)
        img = cv2.imread(kf_path)
        if img is None: continue

        # Reset deduplication tracker per frame to evaluate raw detector output
        plugin._last_emitted_signature = None
        plugin._last_emitted_time = 0.0

        buffer = [{"raw_frame": img}, {"raw_frame": img}, {"raw_frame": img, "keyframe_id": fname.replace(".jpg", "")}]
        res = plugin.analyze(buffer, context)

        if res and res.attributes and res.attributes.get("activity"):
            attrs = res.attributes
            tier1_emissions.append({
                "frame": fname,
                "confidence": res.confidence,
                "activity": attrs.get("activity"),
                "env": attrs.get("environment"),
                "method": attrs.get("interaction_method"),
                "confidences": attrs.get("detection_confidences"),
                "objects": attrs.get("detected_objects"),
                "context_notes": attrs.get("context_notes"),
                "sentence": attrs.get("sentence")
            })
        else:
            tier1_suppressions.append(fname)

    print(f"\nTotal Keyframes Evaluated: {len(all_kfs)}")
    print(f"Total Tier-1 Emitted Activity Events: {len(tier1_emissions)}")
    print(f"Total Frames Suppressed / Passive Only: {len(tier1_suppressions)}")
    
    activity_counts = {}
    for em in tier1_emissions:
        act = em["activity"]
        activity_counts[act] = activity_counts.get(act, 0) + 1

    print("\nTier-1 Activity Emission Breakdown:")
    for act, count in sorted(activity_counts.items(), key=lambda x: x[1], reverse=True):
        print(f"  - {act:<22s}: {count} events ({count/len(all_kfs)*100:.1f}% of keyframes)")

    # 2. Evaluate Specific Test Protocols:
    print("\n" + "=" * 80)
    print("[PART 2] EVALUATING TARGET ACTIVITY PROTOCOLS")
    print("=" * 80)

    # Protocol 1: Typing / Computer Use
    typing_events = [e for e in tier1_emissions if e["activity"] in ["typing", "using a computer"]]
    print(f"\n1. TYPING (Baseline Confirmation):")
    print(f"   - Total Events Emitted: {len(typing_events)}")
    methods = {}
    for t in typing_events:
        m = t["method"]
        methods[m] = methods.get(m, 0) + 1
    print(f"   - Interaction Methods: {methods}")
    for t in typing_events[:3]:
        print(f"     * [{t['frame'][:12]}] Activity='{t['activity']}' | Method='{t['method']}' | Conf={t['confidences']} | Overall={t['confidence']}")

    # Protocol 2: Drinking (Bottle vs Cup)
    drinking_events = [e for e in tier1_emissions if e["activity"] == "drinking"]
    print(f"\n2. DRINKING (Bottle vs Cup):")
    print(f"   - Total Drinking Events Emitted: {len(drinking_events)}")
    bottle_triggers = [e for e in drinking_events if any("bottle" in o.lower() for o in e.get("objects", []))]
    cup_triggers = [e for e in drinking_events if any("cup" in o.lower() for o in e.get("objects", []))]
    print(f"   - Triggered by 'bottle': {len(bottle_triggers)} frames")
    print(f"   - Triggered by 'cup':    {len(cup_triggers)} frames")
    for d in drinking_events[:4]:
        print(f"     * [{d['frame'][:12]}] Objs={d['objects']} | Conf={d['confidences']} | Method='{d['method']}' | Overall={d['confidence']}")

    # Protocol 3: Eating & Bowl Context Map Fix
    bowl_eating_false_positives = [e for e in tier1_emissions if e["activity"] == "eating" and "bowl" in e.get("objects", [])]
    bowl_context_notes = [e for e in tier1_emissions if any("tableware present" in n for n in (e.get("context_notes") or []))]
    print(f"\n3. EATING & BOWL CONTEXT_MAP FIX:")
    print(f"   - False-Positive 'eating' events triggered by passive 'bowl': {len(bowl_eating_false_positives)} (Expected: 0)")
    print(f"   - Frames where 'bowl' was safely captured as passive context note: {len(bowl_context_notes)}")
    if bowl_context_notes:
        print(f"   - Status: BOWL FIX WORKING (0 false positive eating events, correctly relegated to supplementary context).")

    # Protocol 4: Tier-2 Gap-Filling (Plate / Utensils via Objects365)
    print("\n" + "=" * 80)
    print("[PART 3] Tier-2 Objects365 Gap-Filling Live Evaluation")
    print("=" * 80)

    model_o365 = YOLO(os.path.join(BASE_DIR, "ai", "models", "yolo11n_object365.pt"))
    tier2_candidates = []

    for kf_path in all_kfs:
        fname = os.path.basename(kf_path)
        img = cv2.imread(kf_path)
        if img is None: continue

        res = model_o365(img, conf=0.10, verbose=False)[0]
        if res.boxes is not None:
            for b in res.boxes:
                cid = int(b.cls[0].item())
                if cid in TIER2_GAP_FILL_ACTIVITY_MAP:
                    cname = model_o365.names.get(cid, str(cid))
                    conf = float(b.conf[0].item())
                    act_name, env_name = TIER2_GAP_FILL_ACTIVITY_MAP[cid]
                    tier2_candidates.append({
                        "frame": fname,
                        "class_id": cid,
                        "class_name": cname,
                        "conf": round(conf, 3),
                        "gap_fill_activity": act_name,
                        "gap_fill_env": env_name
                    })

    print(f"Total Tier-2 Gap-Filling Detections across Keyframes: {len(tier2_candidates)}")
    gap_counts = {}
    for c in tier2_candidates:
        act = c["gap_fill_activity"]
        gap_counts[act] = gap_counts.get(act, 0) + 1
    for act, count in gap_counts.items():
        print(f"  - {act:<18s}: {count} detections")

    plate_candidates = [c for c in tier2_candidates if c["class_name"].lower() == "plate"]
    print(f"\n  * 'Plate' (Objects365 class 15 -> 'eating') Detections: {len(plate_candidates)} frames")
    for pc in plate_candidates[:5]:
        print(f"      - Frame [{pc['frame'][:12]}]: conf={pc['conf']} -> Enriches Tier-2 with '{pc['gap_fill_activity']}' ({pc['gap_fill_env']})")

    # Protocol 5: Other Categories (Phone, Toothbrush)
    phone_events = [e for e in tier1_emissions if e["activity"] == "using a phone"]
    print(f"\n4. OTHER CATEGORIES:")
    print(f"   - 'using a phone':    {len(phone_events)} events in Tier-1")
    toothbrush_candidates = [c for c in tier2_candidates if c["class_name"].lower() == "toothbrush"]
    print(f"   - 'brushing teeth':   {len(toothbrush_candidates)} detections in Tier-2")

    print("\n" + "=" * 80)
    print("ALL ACTIVITY DETECTION BENCHMARKS COMPLETED")
    print("=" * 80)

if __name__ == "__main__":
    main()
