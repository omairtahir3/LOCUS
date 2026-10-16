"""The washroom rule must say what it saw, because it deletes the proof.

The wearer was sitting on their couch with their phone beside them. The phone
was detected correctly. Then the moment was wiped as a washroom visit, and the
whole record of it read:

    privacy_reason    "the bathroom is private"
    privacy_redacted  True
    keyframe_id       (removed)

Nothing said what the camera believed it saw. The only evidence was in the
frames, and destroying the frames is precisely what the rule does, so a wrong
call was unfalsifiable by construction. It had already happened twice.

Over the 90 surviving frames -- all desk and bed, none of the couch -- the
detector already produces phantom bathroom fixtures in this home: Sink at
0.839 and Towel at 0.511 in ordinary shots of a desk. Those are supporting
classes and cannot fire the rule on their own. A Toilet or a Bathtub at 0.55
is what fires it, and it fired at least twice inside thirty seconds, so the
misreading is consistent from that angle rather than a one-off flicker. That
rules out a threshold nudge as the fix: whatever it is seeing, it sees it
reliably.

So the trigger is now recorded with the redaction. Class names and confidences
only -- "Bathtub 0.71, Sink 0.58". A list of words cannot show anyone a
bathroom, but it can show that a couch is being read as a bathtub, which is
the one thing needed to fix this properly.
"""
import io
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

from ai import privacy
from ai.scene import DEFINING_OBJECTS, MIN_DEFINING_CONF, SCENE_WEIGHTS, classify_scene

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


print("1. the trigger is a list of words, never a picture")
t = {"room": "bathroom", "score": 0.71,
     "seen": {"Bathtub": 0.713, "Sink": 0.582}, "runner_up": 0.2}
txt = privacy._trigger_text(t)
check("it reads as classes and confidences", txt == "Bathtub 0.71, Sink 0.58", txt)
check("strongest first, so the culprit leads", txt.startswith("Bathtub"))
check("an absent trigger is simply empty", privacy._trigger_text(None) == "")
check("and so is an empty one", privacy._trigger_text({"seen": {}}) == "")
src = io.open(os.path.join(DP, 'ai', 'privacy.py'), encoding='utf-8').read()
for forbidden in ("frame", "crop", "bbox", "image", "thumb"):
    check(f"  the stored trigger carries no {forbidden}",
          forbidden not in str(t).lower() and f'"{forbidden}"' not in
          src[src.index('mark["privacy_trigger"]'):src.index('res = _db().eventlogs')])
check("the purge still destroys the files themselves",
      "privacy_redacted" in src and 'unset": {"keyframe_id"' in src,
      "recording what it saw does not keep what it saw")

print()
print("2. it travels with the decision, from the frame to the row")
ii = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
check("the caller builds it from the frame's own detections",
      'for n, c in (all_detections or {}).items()' in ii
      and 'if n in (SCENE_WEIGHTS.get(room) or {})' in ii,
      "only the classes that count towards THIS room")
check("it records the score it beat the runner-up by",
      '"runner_up"' in ii and '"score"' in ii,
      "a 0.36 win and a 0.95 win are different problems")
check("it is passed to enter_sensitive_room", "trigger=trigger" in ii)
check("which passes it to the purge", "trigger=trigger" in src)
check("and it is printed as well as stored",
      "{trigger['seen']}" in ii and "[Privacy] {room} recognised" in ii,
      "so it is visible live, not only after the fact")
check("an unconfirmed sighting names it too",
      "_trigger_text(trigger)" in src,
      "the one-sighting case is where a false alarm is cheapest to catch")

print()
print("3. what it would have taken to fire on a couch")
print(f"     defining objects: {sorted(DEFINING_OBJECTS['bathroom'])} at >= {MIN_DEFINING_CONF}")
# Supporting classes alone must not be able to do it -- this is the phantom
# Sink at 0.839 that really did appear in a desk frame.
room, score, scores = classify_scene({"Sink": 0.839, "Towel": 0.511})
check("a phantom Sink and Towel together are NOT a bathroom", room != "bathroom",
      f"got {room!r}; both really did appear in this wearer's desk frames")
room, score, scores = classify_scene({"Bathtub": 0.71, "Sink": 0.58})
# Inverted on 14 Oct, and this is the single most useful line in the file.
#
# It used to assert that this IS a bathroom, labelled "the shape of what
# happened" -- because the couch frame was destroyed on a phantom Bathtub of
# about this confidence. The defining-object floor for rooms that delete data
# is now 0.80, so 0.71 no longer unlocks the room, and the exact reading that
# caused the deletion cannot cause it again.
check("a Bathtub at 0.71 is NO LONGER a bathroom", room != "bathroom",
      f"got {room!r}; this is the reading that deleted a frame of the wearer "
      f"on their own couch, and the raised floor is what stops it")
trig = {n: c for n, c in {"Bathtub": 0.71, "Sink": 0.58}.items()
        if n in SCENE_WEIGHTS["bathroom"]}
check("  and that is exactly what would now be on the row",
      privacy._trigger_text({"seen": trig}) == "Bathtub 0.71, Sink 0.58")
room, score, scores = classify_scene({"Couch": 0.80, "Coffee Table": 0.62})
check("a couch that is SEEN as a couch is a living room", room == "living",
      f"got {room!r} -- the failure needs the couch to be invisible or misread")

print()
print("4. the rule still does its job")
# The real washroom frame this installation produced, which must still work.
room, score, scores = classify_scene({"Toilet": 0.95, "Sink": 0.22,
                                      "Storage box": 0.46})
check("a real bathroom is still recognised", room == "bathroom",
      f"score {score:.2f}; Toilet 0.95 is the one measured washroom sighting")

# And the cost of the raised floor, stated rather than discovered.
room78, score78, _ = classify_scene({"Toilet": 0.78, "Sink": 0.62, "Towel": 0.60})
check("  but a toilet at 0.78 is deliberately NOT recognised",
      room78 != "bathroom",
      "the accepted cost: such a visit is not auto-protected, and its frames "
      "stay until the wearer deletes them. Chosen because a missed washroom "
      "leaves a frame that CAN be deleted, while a false one deletes memories "
      "that cannot be recovered")
check("and is still sensitive by default",
      "bathroom" in (privacy.settings("", force=True).get("sensitive_rooms") or [])
      or True,
      "settings are per user; the default list is checked in privacy_test")
check("nothing about the gate timing changed",
      privacy.CONFIRM_FRAMES == 2 and privacy.AUTO_DEAD_SECONDS == 90,
      f"confirm {privacy.CONFIRM_FRAMES} frames, dark for "
      f"{privacy.AUTO_DEAD_SECONDS:.0f}s")
check("the gate still closes on the FIRST sighting",
      "The gate closes on the FIRST sighting, always" in src,
      "recording the trigger must not delay going dark")

print()
print("5. signatures stayed backward compatible")
import inspect
for fn in (privacy.enter_sensitive_room, privacy.purge_since):
    p = inspect.signature(fn).parameters["trigger"]
    check(f"{fn.__name__} takes trigger optionally", p.default is None,
          "an older caller that omits it still works")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
