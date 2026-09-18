"""
Verification of 'Using a Phone' in Isolation (No Laptop Present).
Tests the exact logic of EgocentricActivityPlugin when a cell phone is the primary
interactive object in frame (simulating a wearer holding/using their phone away from the desk).
"""

import os
import sys
import glob
import cv2
import numpy as np

BASE_DIR = os.path.abspath(os.path.dirname(__file__))
LOCUS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", ".."))
sys.path.insert(0, BASE_DIR)
sys.path.insert(0, os.path.join(LOCUS_DIR, "ai_backend"))

from ai.plugins.egocentric_activity import EgocentricActivityPlugin
from ai.core.contracts import EventContext
from ultralytics import YOLO

def main():
    print("=" * 80)
    print("VERIFICATION: 'USING A PHONE' DETECTION IN ISOLATION")
    print("=" * 80)

    plugin = EgocentricActivityPlugin()
    context = EventContext(user_id="test_user_phone")

    # 1. Inspect EgocentricActivityPlugin ACTIVITY_MAP entry for cell phone
    print(f"\n[1] Checking ACTIVITY_MAP definition in EgocentricActivityPlugin:")
    phone_action = plugin.ACTIVITY_MAP.get("cell phone")
    print(f"  - 'cell phone' mapped action: '{phone_action}' (Expected: 'using a phone')")
    assert phone_action == "using a phone", "cell phone must map to 'using a phone'"

    # 2. Find a real keyframe where cell phone was detected (e.g. 00912645 at conf=0.24, or 47863b18)
    storage = os.path.join(LOCUS_DIR, "ai_backend", "keyframe_backend", "keyframe_storage")
    kf_path = glob.glob(os.path.join(storage, "**", "*00912645*.jpg"), recursive=True)[0]
    img = cv2.imread(kf_path)
    h, w = img.shape[:2]

    # In this frame, cell phone is at [0, 0, 139, 195]. Let's create an isolated phone usage scene
    # by taking the background and placing the phone in the central interactive zone
    # or testing a simulated phone frame:
    print(f"\n[2] Testing Live Stream Simulation with Cell Phone in Hand / Interactive Zone:")
    
    # Run YOLOv8 on an isolated phone interaction frame:
    # A 640x640 frame with a person's hands holding a smartphone in the center
    # Let's load the detector and verify the exact bounding box & plugin path:
    model = YOLO(os.path.join(BASE_DIR, "yolov8n.pt"))

    # Let's test on an image where cell phone is present without laptop:
    test_frame = np.full((720, 1280, 3), (180, 180, 180), dtype=np.uint8) # Neutral background
    
    # Place a realistic phone image in the lower-center field of view (cx=0.50, cy=0.65)
    phone_crop = img[0:195, 0:139] # Extracted phone crop from real recording
    phone_resized = cv2.resize(phone_crop, (240, 380))
    test_frame[250:630, 520:760] = phone_resized

    # Run YOLO to verify detection on this isolated frame
    res_yolo = model(test_frame, conf=0.20, verbose=False)[0]
    print(f"  - YOLO raw detections on isolated frame:")
    detected_classes = []
    if res_yolo.boxes is not None:
        for b in res_yolo.boxes:
            cname = model.names[int(b.cls[0].item())]
            cconf = float(b.conf[0].item())
            xyxy = [int(x) for x in b.xyxy[0].tolist()]
            detected_classes.append((cname, round(cconf, 3), xyxy))
            print(f"      * '{cname}' (conf={cconf:.3f}) at {xyxy}")

    # Pass buffer to EgocentricActivityPlugin.analyze()
    plugin._last_emitted_signature = None
    plugin._last_emitted_time = 0.0
    buffer = [{"raw_frame": test_frame}, {"raw_frame": test_frame}, {"raw_frame": test_frame, "keyframe_id": "phone_test_001"}]

    res_plugin = plugin.analyze(buffer, context)

    print(f"\n[3] EgocentricActivityPlugin Emission Result:")
    if res_plugin and res_plugin.attributes:
        attrs = res_plugin.attributes
        print(f"  --> ACTIVITY:           '{attrs.get('activity')}'")
        print(f"  --> CONFIDENCE:         {res_plugin.confidence}")
        print(f"  --> INTERACTION METHOD: '{attrs.get('interaction_method')}'")
        print(f"  --> DETECTED OBJECTS:   {attrs.get('detected_objects')}")
        print(f"  --> GENERATED SENTENCE: '{attrs.get('sentence')}'")
        
        if attrs.get('activity') == 'using a phone':
            print("\nRESULT: SUCCESS! 'using a phone' fires cleanly and correctly in isolation.")
        else:
            print(f"\nRESULT: Fired different activity: {attrs.get('activity')}")
    else:
        print("\nRESULT: No activity emitted (Suppressed).")

    print("=" * 80)

if __name__ == "__main__":
    main()
