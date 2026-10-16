"""MobileNet finds; a model that can tell objects apart decides.

Every structural fix this project made to item matching -- tighter crops,
lighting augmentation, adopted views, colour, region proposals, containment --
removed wrong answers and none could separate the wearer's phone from their
television. The reason is in the features, not the search:

    item              agrees with ITSELF    nearest OTHER item
    Phone                          0.663           0.808
    Rover Earbuds                  0.665           0.808
    Car Keys                       0.656           0.797

Every belonging resembles another belonging MORE than it resembles itself.
MobileNetV3-Small is an ImageNet classifier: it answers "is this the same KIND
of thing", and a television is the same kind of thing as a phone.

DINOv2 is self-supervised with an instance-discriminative objective. On crops
confirmed by the wearer:

                         phone<->phone   phone<->television   separation
    MobileNetV3-Small          0.646            0.586           +0.060
    DINOv2 ViT-S/14            0.527            0.219           +0.308

It is five times the separation and thirty-six times the cost -- 1.2 s a crop
against 40 ms, and batching does not help because it is compute-bound. At 140
candidates a frame it would take three minutes. So it never searches. It is
asked only about candidates that already survived, which is at most one per
belonging per frame.

That inverts the economics of the search half. MobileNet no longer has to be
cautious, because something stronger checks it:

    bar    verifier   phones found   false positives
    0.74      no          0/4              1          <- before
    0.74      yes         0/4              0
    0.70      no          2/4              3
    0.70      yes         2/4              0          <- now
    0.62      yes         2/4              0

End to end on the frames the wearer reported:

    04:19  Phone 0.809              found
    08:14  Phone 0.704              found   (reported missing that morning)
    03:51  the laptop-corner decoy  silent
    04:20  candidate 0.718          refused, verifier says 0.242

NO RE-ENROLMENT. The galleries are built from images that already existed: the
single representative photograph each item kept, expanded through the same ten
views enrolment uses, plus crops the wearer confirmed. The original fifteen
enrolment photographs were embedded and discarded, and MobileNet-space vectors
cannot be converted -- which is a lesson about keeping sources, not a blocker
here.
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

import numpy as np
from bson import ObjectId
from pymongo import MongoClient

import ai.item_indexer as II
from ai import verifier

UID = '6a6e439595ff22c2e2f91416'
PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


src = io.open(os.path.join(DP, 'ai', 'item_indexer.py'), encoding='utf-8').read()
vsrc = io.open(os.path.join(DP, 'ai', 'verifier.py'), encoding='utf-8').read()

print("1. it checks, it never searches")
check("the search model is untouched",
      "backbone.extract_batch(crops)" in src,
      "MobileNet still embeds every candidate; that is what it is good at")
check("the verifier is asked only about survivors",
      "for item_id in list(best.keys()):" in src
      and src.index("for item_id in list(best.keys()):") > src.index("for region, emb in zip"),
      "after the scan, on the best candidate per item")
check("  which is at most one call per belonging per frame",
      "del best[item_id]" in src)
check("and there is a hard ceiling besides", 0 < verifier.VERIFY_MAX_PER_FRAME <= 10,
      f"{verifier.VERIFY_MAX_PER_FRAME} per frame")
check("the model is loaded on first use, not at import",
      "def _load()" in vsrc and "_model = None" in vsrc,
      "88 MB that most frames never need")

print()
print("2. it fails OPEN, every way it can fail")
check("an item with no verifier gallery is left alone",
      verifier.agrees(np.zeros((40, 40, 3), np.uint8), None) == (True, 0.0),
      "items enrolled before this existed must not silently stop matching")
check("  and an empty one too",
      verifier.agrees(np.zeros((40, 40, 3), np.uint8), [])[0] is True)
check("a verifier that will not load does not take matching down",
      "_unavailable" in vsrc and "defer to MobileNet" in vsrc)
check("and running out of budget keeps the match",
      "# Out of budget for this frame. Keeping the match is the same" in src)
check("it can be switched off entirely", 'VERIFY_MATCHES", "1"' in vsrc)

print()
print("3. its threshold is derived, not carried over")
check("it has its own bar", 0 < verifier.VERIFY_THRESHOLD < 1,
      f"{verifier.VERIFY_THRESHOLD}, nothing to do with MobileNet's 0.74")
check("the derivation is written down",
      "0.961" in vsrc and "0.399" in vsrc,
      "held-out true sighting against the highest false positive seen")
check("  and those two numbers are labelled as ENROLMENT crops",
      "ENROLMENT-quality crops" in vsrc,
      "0.961 describes a clean photograph, not what this camera produces")
# This used to assert "a gap, not a knife edge" from 0.961 - 0.55, which is
# true of enrolment photographs and false of the body camera. Ten sightings of
# the wearer's phone in one morning verified at 0.557 to 0.725, so the real
# margin above the bar is 0.007, not 0.41. The wearer asked why a 0.561 match
# had been logged; it was their phone, in a 160x80 px sliver of the frame.
check("  the live distribution is recorded beside them",
      "0.725  0.666  0.633  0.595  0.585" in vsrc
      and "0.578  0.577  0.571  0.564  0.557" in vsrc,
      "every phone sighting logged on the morning of 16 Oct")
check("  and the margin that actually applies is named",
      "clears 0.55 by 0.007" in vsrc and "not headroom to spend" in vsrc)
check("  the bar sits above every refusal measured on this camera",
      verifier.VERIFY_THRESHOLD > 0.516,
      "16 refused boxes of an enrolled class ran 0.086 to 0.516")
check("  and below the weakest true sighting",
      verifier.VERIFY_THRESHOLD < 0.557,
      f"{verifier.VERIFY_THRESHOLD} against 0.557 and 0.516 -- "
      "four hundredths either side, so it must not move")

print()
print("4. the search half may now be generous, because something checks it")
check("a blind region's bar relaxes", II.VERIFIED_TILE_THRESHOLD < II.DailyItemIndexer.EXEMPLAR_MATCH_THRESHOLD,
      f"{II.VERIFIED_TILE_THRESHOLD} against {II.DailyItemIndexer.EXEMPLAR_MATCH_THRESHOLD}")
check("ONLY where a verifier gallery exists",
      '_v.VERIFY_MATCHES and len(item.get("verify_embeddings") or [])' in src,
      "an item with nothing to check against keeps the strict bar")
check("and the measurement that justifies it is recorded",
      "0.70      yes         2/4              0" in src)

print()
print("5. the galleries, built from what survived")
db = MongoClient('mongodb://127.0.0.1:27017').locusDB
items = list(db.useritems.find({'user_id': {'$in': [ObjectId(UID), UID]}, 'is_active': True},
                               {'item_name': 1, 'verify_embeddings': 1, 'verify_built_from': 1,
                                'item_embeddings': 1, 'representative_image': 1}))
built = [it for it in items if it.get('verify_embeddings')]
check("every enrolled item has one", len(built) == len(items), f"{len(built)}/{len(items)}")
for it in built:
    src_info = it.get('verify_built_from') or {}
    print(f"     {it['item_name']:<16} {len(it['verify_embeddings']):>3} vectors  "
          f"from {src_info.get('views')} views"
          f"{', ' + str(src_info.get('confirmed_crops')) + ' confirmed' if src_info.get('confirmed_crops') else ''}")
check("they came from the stored photograph, not a new one",
      all((it.get('verify_built_from') or {}).get('representative_photo') for it in built),
      "no re-enrolment was required")
check("and the MobileNet galleries are untouched",
      all(len(it.get('item_embeddings') or []) == 150 for it in built),
      "the search half still works exactly as before")
check("the dimensionality differs, so the two cannot be confused",
      all(len(it['verify_embeddings'][0]) != len(it['item_embeddings'][0]) for it in built),
      f"{len(built[0]['verify_embeddings'][0])}-D verifier against "
      f"{len(built[0]['item_embeddings'][0])}-D search")

print()
print("6. what it does not claim")
check("it cannot rescue a crop the search never proposed",
      "It is NOT a replacement" in vsrc,
      "two of the four frames are still missed; the phone is face-down in the dark")
check("and the feature-space problem it fixes is written down",
      "resembles another belonging" in vsrc or "0.808" in vsrc)

print()
print("7. the relaxation and the check are ONE decision")
check("the lower bar requires a verifier that can actually run",
      "_v.available() and self._verify_budget > 0" in src,
      "a licence to be generous, withdrawn with the thing that justified it")
check("an unverified blind match falls back to the strict bar",
      'if why != "agreed" and sim < item.get("threshold"' in src)
check("and says so rather than passing quietly",
      "the relaxed bar does not apply" in src)
check("the real Car Keys false positive is named in the code",
      "0.705" in src and "car keys" in src.lower(),
      "0.705 cleared the relaxed bar while the check was silently absent")

print()
print("8. every claim records whether it was actually checked")
check("_verified reports WHY, not just yes or no",
      "-> tuple[bool, str, float]" in src)
for why in ("off", "no_gallery", "no_budget", "unavailable", "agreed", "refused"):
    check(f"  it can report {why!r}", f'"{why}"' in src)
check("a blind match carries the outcome onto the event",
      '"verified": self._verify_note.get(item_id' in src)
check("and so does a detector match",
      'd["verified"] = _why' in src and 'd["verify_score"] = round(_vs, 3)' in src,
      "the database can answer this next time instead of a person guessing")
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
