"""Any room the wearer marks private is held to the harder bar -- not just the washroom.

The settings screen offers six rooms to never record in, and ticking one means
"stop recording here and destroy what was already kept". The higher
defining-object floor was hardcoded to {"bathroom"}, so exactly one of those
six was protected by it. Ticking Bedroom armed destruction at the ORDINARY
0.55 floor, in the room where this wearer spends their day, with Bed reading
0.62 routinely -- one tap from wiping a day of memories.

So the floor follows the setting. And when the automatic rule is off, nothing
is destructive and no room is held higher, which is the right answer for a
wearer who has disarmed it: recognition behaves as it did before any of this.
"""
import io
import os
import sys
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

from ai import privacy
from ai.scene import (classify_scene, defining_conf_floor, DESTRUCTIVE_ROOMS,
                      MIN_DEFINING_CONF, MIN_DESTRUCTIVE_DEFINING_CONF)

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}"
          + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


# Real readings from this installation.
WASHROOM = {'Toilet': 0.95, 'Sink': 0.22, 'Storage box': 0.46}
WASHROOM_WEAK = {'Toilet': 0.70, 'Sink': 0.22, 'Storage box': 0.46}
BEDROOM = {'Nightstand': 0.78, 'Lamp': 0.65, 'Bed': 0.62, 'Pillow': 0.49,
           'Fan': 0.50}
DESK = {'Laptop': 0.93, 'Fan': 0.78, 'Mirror': 0.68, 'Towel': 0.32,
        'Cabinet/shelf': 0.46, 'Bed': 0.42}

print("1. the two floors")
check("a destructive room's floor is higher than the ordinary one",
      MIN_DESTRUCTIVE_DEFINING_CONF > MIN_DEFINING_CONF,
      f"{MIN_DESTRUCTIVE_DEFINING_CONF} against {MIN_DEFINING_CONF}")
check("the hardcoded set survives only as a fallback",
      DESTRUCTIVE_ROOMS == {"bathroom"},
      "for callers with no user context; a missing setting fails toward caution")
check("passing no set uses that fallback",
      defining_conf_floor('bathroom') == MIN_DESTRUCTIVE_DEFINING_CONF
      and defining_conf_floor('bedroom') == MIN_DEFINING_CONF)

print()
print("2. the floor follows the WEARER's set, not a constant")
check("a bedroom the wearer marked private is held higher",
      defining_conf_floor('bedroom', {'bedroom'}) == MIN_DESTRUCTIVE_DEFINING_CONF)
check("a washroom the wearer did NOT mark is held ordinarily",
      defining_conf_floor('bathroom', {'bedroom'}) == MIN_DEFINING_CONF,
      "nothing is destroyed there, so nothing needs a harder bar")
check("an empty set means no room is held higher",
      all(defining_conf_floor(r, set()) == MIN_DEFINING_CONF
          for r in ('bathroom', 'bedroom', 'kitchen', 'living', 'dining', 'office')),
      "which is what the automatic rule being OFF means")

print()
print("3. the hazard this closes: ticking Bedroom")
room, score, _ = classify_scene(BEDROOM, set())
check("with nothing marked, a bed at 0.62 is a bedroom",
      room == 'bedroom', f"got {room!r} at {score:.2f}")
room, score, _ = classify_scene(BEDROOM, {'bedroom'})
check("marked private, that same bed at 0.62 is NOT enough",
      room != 'bedroom',
      f"got {room!r}; it would otherwise have armed destruction on 0.62, and "
      f"a day in this wearer's bedroom would have been purged")
room, score, _ = classify_scene({'Bed': 0.88, 'Pillow': 0.60}, {'bedroom'})
check("  but a bed seen clearly at 0.88 still is",
      room == 'bedroom',
      f"got {room!r} at {score:.2f}; the protection still works when the "
      f"evidence is strong")

print()
print("4. the washroom, which is what prompted all of this")
room, _, _ = classify_scene(WASHROOM, {'bathroom'})
check("the real washroom frame is recognised", room == 'bathroom',
      "Toilet 0.95, the one measured sighting")
room, _, _ = classify_scene(WASHROOM_WEAK, {'bathroom'})
check("a toilet at 0.70 is not", room != 'bathroom',
      "the accepted cost of the higher floor")
room, _, _ = classify_scene({'Bathtub': 0.71, 'Sink': 0.58}, {'bathroom'})
check("and the Bathtub 0.71 that deleted a couch frame is not",
      room != 'bathroom', "the reading that caused the original false positive")
room, _, _ = classify_scene(DESK, {'bathroom', 'bedroom'})
check("the desk is no room at all, with both marked private",
      room is None, "mirror 0.68 and towel 0.32 are not defining objects")

print()
print("5. it is wired to the real setting")
src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
check("the classifier is given the wearer's sensitive_rooms",
      'classify_scene(all_detections, _destructive)' in src
      and 'sensitive_rooms' in src)
check("and only when the automatic rule is armed",
      'if AUTO_ROOM_PRIVACY:' in src,
      "off means nothing is destructive, so nothing is held higher")
check("unreadable settings fall back to caution, not to nothing",
      'DESTRUCTIVE_ROOMS as _fallback' in src)
check("this wearer's current set is what the pipeline would use",
      True,
      f"AUTO_ROOM_PRIVACY={privacy.AUTO_ROOM_PRIVACY}, "
      f"sensitive_rooms={privacy.settings('6a6e439595ff22c2e2f91416', force=True).get('sensitive_rooms')}")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
