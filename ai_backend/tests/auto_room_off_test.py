"""The automatic room rule is off. It still watches; it no longer acts.

It destroyed a moment the wearer was present for -- sitting on their couch
with their phone beside them, which the scene classifier called a bathroom --
and it had done the same once before. The phone in that frame was matched
correctly, so the detector was working; it simply also believed it was looking
at a bathroom.

The case for switching it off rather than retuning it:

  * over the 90 surviving frames, all desk and bed, the detector already
    invents bathroom fixtures in this home -- a phantom Sink at 0.839 and a
    Towel at 0.511 in ordinary shots of a desk
  * those are supporting classes and provably cannot fire it alone
  * it needs a Toilet or Bathtub at 0.55, and it fired at least twice inside
    thirty seconds, so the misreading is consistent rather than a flicker,
    and a higher threshold would postpone it rather than fix it
  * and the thing that would identify the culprit -- the frame -- is the one
    thing the rule destroys

So: off, but still classifying, and still writing down what it would have
done. note_would_have_fired records the classes and confidences and touches no
file. The culprit gets named from ordinary use at no risk, and the rule can
then come back with that one class removed from DEFINING_OBJECTS.

Untouched: the privacy button, blur mode, and sensitive PLACES, which the
wearer named themselves and which have never misfired.
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

from bson import ObjectId
from pymongo import MongoClient

from ai import privacy

UID = '6a6e439595ff22c2e2f91416'
PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = io.open(os.path.join(DP, 'ai', 'privacy.py'), encoding='utf-8').read()
ii = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()

print("1. the rule is armed again, and only two classes can arm it")
# Was asserted OFF between 12 and 14 Oct, after it purged a frame of the wearer
# on their own couch. Back on at their instruction once the measurement the
# disabling comment asked for existed: over 35 stored frames holding any
# bathroom-weighted class, Toilet appeared once (0.95, the real washroom) and
# Bathtub never, while Mirror (31 frames, <=0.70) and Towel (4, <=0.36) were
# all the desk -- and neither of those can fire it.
check("AUTO_ROOM_PRIVACY is on by default", privacy.AUTO_ROOM_PRIVACY is True)
check("a bathroom is a sensitive room again",
      privacy.is_sensitive_room(UID, 'bathroom') is True,
      "as it is listed in the wearer's settings")
check("a bedroom is NOT, so the rule did not widen",
      privacy.is_sensitive_room(UID, 'bedroom') is False)
from ai.scene import DEFINING_OBJECTS
check("only Toilet and Bathtub can call a room a bathroom",
      DEFINING_OBJECTS['bathroom'] == {'Toilet', 'Bathtub'},
      f"{sorted(DEFINING_OBJECTS['bathroom'])}; Sink 0.6, Towel 0.55, "
      f"Toothbrush and Soap 0.7 are all under the 0.8 cut")
check("  which is what the matcher asks before destroying anything",
      "if not is_sensitive_room(user_id_str, room):" in ii)
check("it is still listed in settings, so nothing was silently unset",
      'bathroom' in (privacy.settings(UID, force=True).get('sensitive_rooms') or []),
      "turning the rule back on needs no re-configuring")
# The claim is controllability, not the direction of the default.
check("it can be turned OFF again without editing code",
      'AUTO_ROOM_PRIVACY", "1"' in src,
      "AUTO_ROOM_PRIVACY=0 disarms it")
check("and the measurement that justified re-arming it is written down",
      "Toilet    ONCE, at 0.95" in src and "Mirror    31 frames" in src)
check("including what it is NOT a guarantee of",
      "Removed promptly" in src or "removes them promptly" in src,
      "classification runs behind capture, so the frame is written then purged")

print()
print("2. it still watches, and writes down what it would have done")
check("the classifier's opinion survives separately",
      privacy.would_be_sensitive_room(UID, 'bathroom') is True)
check("the matcher asks THAT to decide whether to look at all",
      "if would_be_sensitive_room(user_id_str, room):" in ii)
check("a near-miss is recorded rather than acted on",
      "note_would_have_fired(user_id_str, room, trigger)" in ii)
check("and the record carries the classes and confidences",
      '"seen": (trigger or {}).get("seen")' in src)
check("it destroys nothing",
      all(w not in src[src.index("def note_would_have_fired"):
                       src.index("# ── the retroactive half")]
          for w in ("os.remove", "unlink", "purge_since", "mark_dead")),
      "no file touched, no gate closed")

print()
print("3. a real near-miss, end to end")
db = MongoClient('mongodb://127.0.0.1:27017').locusDB
before = db.eventlogs.count_documents({"details.action": "privacy_auto_would_fire"})
privacy.note_would_have_fired(UID, "bathroom", {
    "room": "bathroom", "score": 1.058,
    "seen": {"Bathtub": 0.71, "Sink": 0.58}, "runner_up": 0.2})
after = db.eventlogs.count_documents({"details.action": "privacy_auto_would_fire"})
check("the near-miss reached the database", after == before + 1)
row = db.eventlogs.find_one({"details.action": "privacy_auto_would_fire"},
                            sort=[("_id", -1)])
check("  naming the room", (row or {})["details"]["room"] == "bathroom")
check("  and exactly what convinced it",
      (row or {})["details"]["seen"] == {"Bathtub": 0.71, "Sink": 0.58},
      str((row or {})["details"]["seen"]))
check("  with no keyframe reference", not (row or {}).get("keyframe_id"))
check("  and nothing marked as redacted", not (row or {}).get("privacy_redacted"),
      "nothing was destroyed, so nothing is redacted")
db.eventlogs.delete_one({"_id": row["_id"]})
check("  (test row cleaned up)",
      db.eventlogs.count_documents({"details.action": "privacy_auto_would_fire"}) == before)

print()
print("4. the wearer's own controls are untouched")
check("the privacy button still governs capture",
      'mode") == "paused"' in src or "'paused'" in src)
check("blur mode is still a separate state", '"blur"' in src)
check("sensitive PLACES are unaffected by the room switch",
      "AUTO_ROOM_PRIVACY" not in src[src.index("places = settings(user_id)"):
                                     src.index("places = settings(user_id)") + 1500],
      "an address the wearer named is not a guess by a classifier")
check("mark_dead still exists for the manual path", hasattr(privacy, "mark_dead"))
st = privacy.state(UID)
check("and right now capture is allowed", st["capture"] is True and st["blur"] is False,
      str(st))

print()
print("5. nothing was deleted to achieve this")
check("the room rule's machinery is all still present",
      all(hasattr(privacy, f) for f in
          ("enter_sensitive_room", "left_sensitive_room", "purge_since",
           "is_sensitive_room", "would_be_sensitive_room")))
check("the purge path is intact for when it is switched back on",
      "def purge_since" in src and "privacy_trigger" in src)
check("and the trigger record it will then write is still wired",
      "trigger=trigger" in ii)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
