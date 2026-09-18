"""Append reference embeddings to an existing enrolled item from a phone video.

Option 3 test: the existing gallery was built from phone photos taken at
eye-level angles, and scored 0.600 against real chest-cam footage - inside the
distractor band (measured ceiling 0.643). This extracts frames from a
deliberately downward-angled sweep and appends them to the SAME gallery, so the
matcher (which takes max similarity across embeddings) gains a same-angle path
to match on without discarding the existing references.

Uses the running FastAPI /api/detection/extract-embedding endpoint - the exact
path mobile enrollment uses - so embeddings are produced identically.

Usage:
    python scripts/enroll_from_video.py --video keys_sweep.mp4 --item "Car Keys"
    python scripts/enroll_from_video.py --video keys_sweep.mp4 --item "Car Keys" --dry-run
"""
import argparse
import base64
import json
import os
import urllib.request

import cv2
import numpy as np
from pymongo import MongoClient

AI_BACKEND = "http://localhost:8000/api/detection/extract-embedding"


def sharpest_frames(video_path: str, want: int) -> list:
    """Pick `want` frames spread across the video, preferring sharp ones.

    Samples 3x more candidates than needed at even intervals, then keeps the
    sharpest within each bucket - a blurry sweep frame would poison the gallery.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {video_path}")
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if total <= 0:
        raise SystemExit("Video reports zero frames")
    print(f"  video: {total} frames @ {fps:.1f}fps ({total/fps:.1f}s)")

    buckets = [[] for _ in range(want)]
    step = max(1, total // (want * 3))
    for idx in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            continue
        blur = cv2.Laplacian(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
        b = min(want - 1, int(idx / max(1, total) * want))
        buckets[b].append((blur, idx, frame))
    cap.release()

    picked = []
    for b in buckets:
        if b:
            blur, idx, frame = max(b, key=lambda x: x[0])
            picked.append((idx, blur, frame))
    return picked


def embed(frames: list) -> list:
    """Embed via the same endpoint mobile enrollment uses."""
    payload = []
    for _, _, f in frames:
        ok, buf = cv2.imencode(".jpg", f, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
        if ok:
            payload.append(base64.b64encode(buf.tobytes()).decode())
    req = urllib.request.Request(
        AI_BACKEND,
        data=json.dumps({"frames": payload}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.loads(r.read()).get("embeddings", [])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--item", required=True, help="Exact item_name of the enrolled item")
    ap.add_argument("--count", type=int, default=12, help="Frames to extract (default 12)")
    ap.add_argument("--dry-run", action="store_true", help="Report only; do not modify the gallery")
    a = ap.parse_args()

    db = MongoClient("mongodb://localhost:27017", serverSelectionTimeoutMS=5000)["locusDB"]
    item = db.useritems.find_one({"item_name": a.item})
    if not item:
        names = [d["item_name"] for d in db.useritems.find({}, {"item_name": 1})]
        raise SystemExit(f"No enrolled item named {a.item!r}. Available: {names}")

    existing = item.get("item_embeddings", [])
    print(f"  item {a.item!r}: {len(existing)} existing embeddings")

    frames = sharpest_frames(a.video, a.count)
    print(f"  extracted {len(frames)} frames (blur scores: "
          f"{', '.join(f'{b:.0f}' for _, b, _ in frames)})")

    new = embed(frames)
    if not new:
        raise SystemExit("Embedding endpoint returned nothing - is the AI backend running?")
    print(f"  embedded {len(new)} frames ({len(new[0])}-D)")

    # How different are the new angles from what is already stored? If these are
    # near-identical to the existing references, the sweep did not add coverage.
    if existing:
        e = np.array(existing, dtype=np.float32)
        n = np.array(new, dtype=np.float32)
        e /= np.linalg.norm(e, axis=1, keepdims=True)
        n /= np.linalg.norm(n, axis=1, keepdims=True)
        sim = n @ e.T
        print(f"  new-vs-existing similarity: max={sim.max():.3f} mean={sim.mean():.3f}")
        print("    (lower = genuinely new angles, which is the point)")

    if a.dry_run:
        print("  --dry-run: gallery unchanged")
        return

    db.useritems.update_one({"_id": item["_id"]},
                            {"$set": {"item_embeddings": existing + new}})
    print(f"  gallery now {len(existing) + len(new)} embeddings "
          f"({len(existing)} phone-photo + {len(new)} downward-sweep)")


if __name__ == "__main__":
    main()
