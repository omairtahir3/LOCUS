"""A tile has no class, so it answers to enrolment and nothing else.

Adopted views -- sightings the camera was confident enough to learn from --
are scoped everywhere else to a detector class that AGREES with the item. That
scope is what keeps the extra latitude safe: a view may widen what an item
looks like only once something independent has said what the object is.

A TILE has no class. It is a blind square of pixels swept across the frame,
so there was nothing for the scope to agree with and the guard silently did
not apply. The tile scanner read item["embeddings"], adopted vectors and all.

It cost a real false positive within hours of adoption shipping. On the
03:51 frame the corner of the wearer's laptop screen -- dark bezel, lit panel
-- was logged as their Phone at 0.781, while the phone itself lay on the bed
to its right and was missed:

                           laptop corner    the real phone
    enrolment only            0.695             0.608
    with adopted views        0.763             0.715
    the bar                   0.74              0.74

Adoption lifted both, which is exactly what it is for. But it pushed the WRONG
one over the bar and left the right one under, and the three vectors it had
adopted that day all came from the desk beside that same laptop.

So the tile scanner now uses the enrolment vectors alone. The laptop is
refused outright. The phone on the bed is still missed at 0.608, and that is
the honest trade: a tile scan is the weakest evidence the system has -- no
detector, no class, no hand, just a square that resembles something -- so it
answers to what the wearer actually enrolled and not to what the system taught
itself.
"""
import glob
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

import cv2
import numpy as np
from bson import ObjectId
from pymongo import MongoClient

import ai.item_indexer as II

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

print("1. the rule")
check("the tile scanner asks for the enrolment vectors",
      'gallery = item.get("enrol_embeddings") or item["embeddings"]' in src)
check("and scores against those, not the grown gallery",
      "sims = np.asarray(gallery) @ emb" in src)
check("the cache still offers both, so this is a choice and not an accident",
      '"enrol_embeddings": embs_arr,' in src and '"embeddings": embs_arr + adopted,' in src)
check("the DETECTOR path still uses adopted views when the class agrees",
      "galleries if self._class_agrees(d, item)" in src,
      "this narrows the blind path only; a classed box keeps the benefit")
check("the reason is written where the code is",
      "A TILE has no class" in src or "A tile" in src)

print()
print("2. measured on the frame it got wrong")
db = MongoClient('mongodb://127.0.0.1:27017').locusDB
it = db.useritems.find_one({'user_id': {'$in': [ObjectId(UID), UID]},
                            'item_name': 'Phone', 'is_active': True})
frames = glob.glob(os.path.join(AI, 'keyframe_backend', 'items_storage',
                                '*', '*', '96993205*.jpg'))
if not it or not frames:
    print("     SKIPPED: the frame and gallery this was measured on have aged out")
    print("     (keyframes are deleted after 36 h; the recorded figures stand)")
else:
    from ai.embedding_backbone import ItemEmbeddingBackbone
    bb = ItemEmbeddingBackbone.get_instance()
    enrol = np.array(it['item_embeddings'], np.float32)
    adopted = np.array(it.get('adopted_embeddings') or [], np.float32)
    img = cv2.imread(frames[0])
    laptop = bb.extract_batch([img[162:282, 964:1084]])[0]
    phone = bb.extract_batch([img[330:390, 1090:1150]])[0]
    BAR = II.DailyItemIndexer.EXEMPLAR_MATCH_THRESHOLD
    e_lap, e_ph = float((enrol @ laptop).max()), float((enrol @ phone).max())
    print(f"     the bar for a tile scan is {BAR}")
    print(f"     enrolment only     laptop {e_lap:.3f}   real phone {e_ph:.3f}")
    if len(adopted):
        a_lap, a_ph = float((adopted @ laptop).max()), float((adopted @ phone).max())
        print(f"     with adopted views laptop {a_lap:.3f}   real phone {a_ph:.3f}")
        check("adopted views really did lift the laptop over the bar",
              a_lap >= BAR > e_lap,
              f"{e_lap:.3f} -> {a_lap:.3f}; this is the regression, not a hypothetical")
        check("and they lifted the real phone too, just not far enough",
              a_ph > e_ph and a_ph < BAR,
              f"{e_ph:.3f} -> {a_ph:.3f}, still under {BAR}")
    check("on enrolment alone the laptop is refused", e_lap < BAR,
          f"{e_lap:.3f} < {BAR}")
    check("the phone on the bed is still missed, and the test says so",
          e_ph < BAR, f"{e_ph:.3f} -- correctness bought at the cost of this sighting")

    print()
    print("3. end to end, through the real scanner")
    idx = II.DailyItemIndexer.get_instance()
    idx._ensure_model_loaded()
    idx._user_items_cache = {}
    tiles = idx._scan_tiles_for_enrolled_items(img, UID, exclude_item_ids=set())
    named = {t["name"] for t in tiles}
    check("the laptop is no longer logged as the phone", "Phone" not in named,
          f"{len(tiles)} tile match(es): {sorted(named) if named else 'none'}")

print()
print("4. nothing else was narrowed")
check("adoption is off entirely now, so this is belt and braces",
      II.ADOPT_SIGHTINGS is False,
      "the scope still matters: it is what should guard adoption if it returns")
check("the cap is unchanged", II.ADOPT_MAX_PER_ITEM == 10)
check("and the near-miss retry is untouched", II.NEAR_MISS_RETRY is True,
      "it runs on classed detector boxes, which still carry the guard")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
