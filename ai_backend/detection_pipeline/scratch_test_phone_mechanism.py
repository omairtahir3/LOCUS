"""
Mathematical & Algorithmic Trace of _find_interacting_activity for Cell Phone.
Demonstrates:
1. Desk Scenario (Laptop center, Phone peripheral): Laptop wins -> 'typing' (0.75)
2. Isolated Phone Scenario (Phone center): Phone wins -> 'using a phone' (0.75)
3. Handheld Bystander Phone Scenario: Phone on bystander -> 'using a phone' (0.55 / 0.65)
"""

import sys
import numpy as np
import torch
from types import SimpleNamespace

sys.path.insert(0, "ai_backend/detection_pipeline")
from ai.plugins.egocentric_activity import EgocentricActivityPlugin

plugin = EgocentricActivityPlugin()
frame_w, frame_h = 1280, 720

print("=" * 80)
print("ALGORITHMIC TRACE: _find_interacting_activity FOR PHONE")
print("=" * 80)

# SCENARIO A: Desk Scenario (Laptop in center, Phone in top-left corner)
print("\n[Scenario A] Desk Work: Center Laptop [400, 300, 900, 700], Peripheral Phone [50, 50, 200, 250]")
boxes_A = SimpleNamespace(
    cls=torch.tensor([63, 67]), # 63=laptop, 67=cell phone
    conf=torch.tensor([0.92, 0.45]),
    xyxy=torch.tensor([
        [400.0, 300.0, 900.0, 700.0], # Laptop center
        [50.0, 50.0, 200.0, 250.0],   # Phone peripheral
    ])
)
names = {63: 'laptop', 67: 'cell phone', 0: 'person'}

act_A, conf_A, method_A = plugin._find_interacting_activity(boxes_A, names, frame_h, frame_w)
print(f"  --> Selected Activity: '{act_A}' | Confidence: {conf_A} | Method: '{method_A}'")
assert act_A == "typing" and method_A == "center_frame", "Laptop must win when in center"

# SCENARIO B: Isolated Phone Use (Wearer holding phone in center of view, no laptop)
print("\n[Scenario B] Isolated Phone: Phone held in center of chest/hand view [500, 320, 780, 680]")
boxes_B = SimpleNamespace(
    cls=torch.tensor([67]), # 67=cell phone
    conf=torch.tensor([0.78]),
    xyxy=torch.tensor([
        [500.0, 320.0, 780.0, 680.0] # Phone centered
    ])
)
act_B, conf_B, method_B = plugin._find_interacting_activity(boxes_B, names, frame_h, frame_w)
print(f"  --> Selected Activity: '{act_B}' | Confidence: {conf_B} | Method: '{method_B}'")
assert act_B == "using a phone" and method_B == "center_frame", "Phone must win when in center"

# SCENARIO C: Handheld Phone with Bystander Visible
print("\n[Scenario C] Phone in Wearer Hand with Bystander seated across table [100, 100, 400, 600]")
boxes_C = SimpleNamespace(
    cls=torch.tensor([0, 67]), # 0=person, 67=cell phone
    conf=torch.tensor([0.85, 0.72]),
    xyxy=torch.tensor([
        [100.0, 100.0, 400.0, 600.0], # Person on left
        [520.0, 350.0, 760.0, 690.0], # Phone center-right
    ])
)
act_C, conf_C, method_C = plugin._find_interacting_activity(boxes_C, names, frame_h, frame_w)
print(f"  --> Selected Activity: '{act_C}' | Confidence: {conf_C} | Method: '{method_C}'")
assert act_C == "using a phone" and method_C == "center_frame_with_bystander", "Wearer phone must win with bystander"

print("\n" + "=" * 80)
print("ALL PHONE INTERACTION LOGIC PATHS MATHEMATICALLY VERIFIED [OK]")
print("=" * 80)
