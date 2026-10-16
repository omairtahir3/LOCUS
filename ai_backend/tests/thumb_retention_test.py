"""A frame that expires must take its rendered copies with it.

The audit grid asks for `/image?w=240` per tile, and the API caches a
width-bounded JPEG per frame so it is not decoding 1280x720 on every page view.
The cache key carries the source mtime and size:

    1db87539-b495-416d-aaba-cc394cf870f0.1792122979.123965.w240.jpg
    └─ keyframe id ──────────────────────┘ └─mtime──┘ └─size┘ └w┘

Three paths delete a frame and only two of them knew about that copy. The
manual delete endpoints glob it out, and the retroactive privacy sweep does too
-- so the wearer's deleted bathroom frames took their thumbnails with them. The
36 h retention sweeper removed {id}.jpg and {id}.json and stopped there.

Measured on the wearer's machine before this was fixed:

    frames on disk across 5 stores: 85
    thumbnails: 493 files, 3.1 MB
      orphaned (source frame already deleted): 486 (99%)
      oldest thumbnail: 14.2 days old

3.1 MB is nothing beside a 208 GB disk, and the bytes are not the point. The
point is that "frames are gone after 36 hours" was untrue of the only copy the
grid actually renders, and nothing in the system would ever have made it true.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import uuid
import warnings
from datetime import datetime, timedelta, timezone

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}"
          + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


from keyframe_backend import keyframe as kf  # noqa: E402

ksrc = io.open(os.path.join(AI, 'keyframe_backend', 'keyframe.py'),
               encoding='utf-8').read()
rsrc = io.open(os.path.join(AI, 'keyframe_backend', 'routes.py'),
               encoding='utf-8').read()
psrc = io.open(os.path.join(DP, 'ai', 'privacy.py'), encoding='utf-8').read()


def plant(root, kid, age_hours):
    """One frame, its sidecar and two cached renderings."""
    day = os.path.join(root, "user1", "2026-10-16")
    os.makedirs(day, exist_ok=True)
    saved = datetime.now(timezone.utc) - timedelta(hours=age_hours)
    io.open(os.path.join(day, kid + ".json"), "w", encoding='utf-8').write(
        json.dumps({"id": kid, "saved_at": saved.isoformat(),
                    "user_id": "user1", "event_type": "scene_change"}))
    io.open(os.path.join(day, kid + ".jpg"), "wb").write(b"\xff\xd8\xff\xd9")
    thumbs = []
    for w in (160, 240):
        t = os.path.join(kf.THUMB_CACHE_DIR, f"{kid}.1792122979.123965.w{w}.jpg")
        io.open(t, "wb").write(b"\xff\xd8\xff\xd9")
        thumbs.append(t)
    return os.path.join(day, kid + ".jpg"), os.path.join(day, kid + ".json"), thumbs


print("1. an expired frame takes its thumbnails with it")
tmp = tempfile.mkdtemp(prefix="locus_thumb_test_")
real_thumbs = kf.THUMB_CACHE_DIR
kf.THUMB_CACHE_DIR = os.path.join(tmp, "thumb_cache")
os.makedirs(kf.THUMB_CACHE_DIR, exist_ok=True)
try:
    store_dir = os.path.join(tmp, "keyframe_storage")
    old_id, young_id = str(uuid.uuid4()), str(uuid.uuid4())
    o_jpg, o_json, o_thumbs = plant(store_dir, old_id, age_hours=48)
    y_jpg, y_json, y_thumbs = plant(store_dir, young_id, age_hours=1)

    store = kf.KeyframeStorage(storage_dir=store_dir, ttl_hours=36)
    deleted = store.cleanup_expired()

    check("the expired frame is gone", not os.path.exists(o_jpg),
          f"{deleted} deleted at a 36 h TTL")
    check("so is its sidecar", not os.path.exists(o_json))
    check("and BOTH of its cached renderings",
          not any(os.path.exists(t) for t in o_thumbs),
          "one frame can have a thumbnail per width, so the glob is by id")

    check("a frame still inside the window is untouched", os.path.exists(y_jpg))
    check("and keeps its renderings",
          all(os.path.exists(t) for t in y_thumbs),
          "deleting these would only force them to be rendered again")
finally:
    kf.THUMB_CACHE_DIR = real_thumbs
    shutil.rmtree(tmp, ignore_errors=True)

print()
print("2. every path that deletes a frame knows about them")
check("retention, in both sweepers",
      ksrc.count("_drop_thumbnails(kid)") == 2,
      "KeyframeStorage covers the four stores that subclass it; "
      "MedicationEvidenceStorage carries its own copy of the loop")
check("the manual delete endpoint",
      "THUMB_CACHE_DIR, keyframe_id" in rsrc)
check("the medication evidence delete",
      "THUMB_CACHE_DIR, base" in rsrc)
check("and the retroactive privacy sweep",
      "_thumb_dir()" in psrc,
      "a frame deleted for privacy must not leave a readable rendering")

print()
print("3. there is one definition of where they live")
check("keyframe.py owns it",
      'THUMB_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),'
      in ksrc)
check("and routes.py imports rather than repeats it",
      "from .keyframe import THUMB_CACHE_DIR" in rsrc,
      "two copies of this path is how the sweeper came to miss them")
check("retention could not have imported it the other way",
      "from .keyframe import" in rsrc and "from .routes import" not in ksrc,
      "routes imports keyframe, so the constant has to live in keyframe")

print()
print("4. the measurement that prompted it is recorded")
check("the orphan rate is named",
      "486" in ksrc and "99%" in ksrc)
check("and that the bytes were never the point",
      "36 h TTL" in ksrc or "36 hours" in ksrc,
      "the claim being repaired is the retention promise, not disk space")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
