"""A second opinion on an exemplar match, from a model that can actually tell
one object from another.

MobileNetV3-Small is an ImageNet CLASSIFIER. It was trained to separate cats
from dogs, not this phone from that phone, and on this installation's data the
consequence is stark: every enrolled belonging resembles another belonging
MORE than it resembles itself.

    item              agrees with ITSELF    nearest OTHER item
    Phone                          0.663           0.808
    Rover Earbuds                  0.665           0.808
    Car Keys                       0.656           0.797

No threshold fixes that, and several sessions of work went into proving it:
better crops, lighting augmentation, region proposals, adopted views, colour
histograms. Each removed wrong answers; none could separate a phone from a
television, because the separation is not present in the features.

DINOv2 is self-supervised with an instance-discriminative objective, so its
features answer "is this the same thing" rather than "is this the same kind of
thing". Measured on crops confirmed by the wearer:

                         phone<->phone   phone<->television   separation
    MobileNetV3-Small          0.646            0.586           +0.060
    DINOv2 ViT-S/14            0.527            0.219           +0.308

and with a gallery built only from surviving images, on a held-out sighting:

    the real phone, held out          0.961
    eight televisions                 0.095 - 0.399
    other dark clutter                0.234 - 0.256

It is NOT a replacement. It costs about 1.2 s per crop on this CPU against
MobileNet's 40 ms, and batching does not help -- it is compute-bound, not
overhead-bound. At 140 candidate crops per frame it would take three minutes.

So it never searches. MobileNet finds and ranks, which is all a search has to
do and which it does adequately: the real phone was already ranked first in a
blind sweep. This model is asked only about the handful that survived, which
is where the +0.308 matters -- at the moment of saying yes.
"""
from __future__ import annotations

import os
import threading

import cv2
import numpy as np

# Instance-level features, small enough to run on a CPU at all.
VERIFY_MODEL = os.environ.get("VERIFY_MODEL", "vit_small_patch14_dinov2.lvd142m")

# Off unless a gallery exists for it: a verifier with nothing to compare
# against would refuse every match and take the system backwards.
VERIFY_MATCHES = os.environ.get("VERIFY_MATCHES", "1") != "0"

# The bar in DINOv2 space. Nothing to do with the 0.74 of MobileNet space --
# a cosine in one feature space means nothing in another, so this is derived
# from measurement rather than carried over.
#
# Measured first on ENROLMENT-quality crops:
#
#     held-out true sighting            0.961
#     highest false positive seen       0.399   (a television)
#
# which reads as 0.4 of room on the true side. On the body camera's own frames
# it is nothing like that wide. Every sighting of the wearer's phone logged on
# the morning of 16 Oct 2026, scored by this model:
#
#     0.725  0.666  0.633  0.595  0.585
#     0.578  0.577  0.571  0.564  0.557
#
# The worst of them clears 0.55 by 0.007.
#
# The 0.595 in that list is the one confirmed by eye, because the wearer asked
# why it had been logged: a 160x80 px sliver of phone clipped against the
# bottom-left corner of the frame, 1.4% of the image, dark and textureless
# against patterned bedding, which YOLO rated 0.096 and MobileNet 0.561. It
# really was their phone -- and this model is the only reason it survived, as
# a box that faint faces a bar of 0.75 in MobileNet space when nothing is able
# to verify it (see VERIFIED_BOX_THRESHOLD in item_indexer.py).
#
# On the false side the nearest figure from this camera is the 16 boxes of an
# enrolled class recorded at item_indexer.py's position gate, which this model
# refuses at 0.086 to 0.516.
#
# Different days and different boxes, so read it as indicative rather than a
# clean separation -- but on live crops the gap either side of this bar is
# roughly 0.516 to 0.557, about four hundredths, not the 0.56 the enrolment
# figures suggest. The bar still sits inside it and should not move: lowering
# it reaches refused boxes almost immediately, and raising it starts dropping
# real sightings at once. The 0.961 describes a clean enrolment photograph and
# is not headroom to spend.
VERIFY_THRESHOLD = float(os.environ.get("VERIFY_THRESHOLD", 0.55))

# How many candidates may be verified per frame. The cost is linear and this
# is the only thing holding it down; a frame offering more than this is
# already suspicious.
VERIFY_MAX_PER_FRAME = int(os.environ.get("VERIFY_MAX_PER_FRAME", 3))

_lock = threading.Lock()
_model = None
_transform = None
_unavailable = None


def _load():
    """Loaded on first use. Never in __init__: it is 88 MB and most frames
    never produce a candidate worth verifying."""
    global _model, _transform, _unavailable
    if _model is not None or _unavailable:
        return _model
    with _lock:
        if _model is not None or _unavailable:
            return _model
        try:
            import timm
            import torch
            # Process-wide, so this one line governs MobileNetV3 and
            # ultralytics as well as DINOv2.
            #
            # It used to read os.cpu_count(), which is the LOGICAL count: 8 on
            # a machine with 4 physical cores. Together with the pill
            # detector's 7 that put roughly 23 threads on 4 cores, and
            # everything slowed down at once -- one frame through the item
            # indexer costs 1.2 s idle and was measured at 29 s and 69 s
            # during a medication window, which is where the three-minute lag
            # in the item feed came from.
            torch.set_num_threads(int(os.environ.get("TORCH_THREADS", 2)))
            m = timm.create_model(VERIFY_MODEL, pretrained=True, num_classes=0).eval()
            cfg = timm.data.resolve_data_config({}, model=m)
            _transform = timm.data.create_transform(**cfg)
            _model = m
            print(f"[Verifier] {VERIFY_MODEL} ready")
        except Exception as e:
            # The pipeline carries on with MobileNet alone. A verifier that
            # cannot load must not take matching down with it.
            _unavailable = f"{type(e).__name__}: {e}"
            print(f"[Verifier] unavailable, matches will not be second-guessed: {_unavailable}")
    return _model


def available() -> bool:
    return _load() is not None


def embed(crops: list) -> np.ndarray | None:
    """L2-normalised features for a list of BGR crops, or None."""
    m = _load()
    if m is None or not crops:
        return None
    try:
        import torch
        from PIL import Image
        batch = torch.stack([
            _transform(Image.fromarray(cv2.cvtColor(c, cv2.COLOR_BGR2RGB)))
            for c in crops])
        with torch.no_grad():
            v = m(batch).numpy()
        n = np.linalg.norm(v, axis=1, keepdims=True)
        return v / np.where(n == 0, 1, n)
    except Exception as e:
        print(f"[Verifier] embedding failed: {e}")
        return None


def agrees(crop, gallery, threshold: float = None) -> tuple[bool, float]:
    """Does this crop really show the item that `gallery` describes?

    Returns (verdict, score). An ABSENT gallery returns (True, 0.0): an item
    enrolled before this model existed has nothing to be checked against, and
    refusing it would silently delete a working feature.
    """
    if gallery is None or not len(gallery):
        return True, 0.0
    e = embed([crop])
    if e is None:
        return True, 0.0          # verifier down: defer to MobileNet
    sim = float(np.max(np.asarray(gallery, dtype=np.float32) @ e[0]))
    return sim >= (VERIFY_THRESHOLD if threshold is None else threshold), sim
