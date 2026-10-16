"""A wall clock is not a pill, and a rejected dose keeps no photograph.

The wearer lifted their laptop with both hands and the system filed the moment
as medication evidence needing confirmation, at 0.742. Running the pills model
on that exact frame shows why:

    conf 0.778   bbox (3,282)-(111,342)     the FAN's circular dial
    conf 0.770   bbox (547,40)-(618,97)     the WALL CLOCK

Round, pale, roughly symmetric -- which is the whole of what a pill detector
knows. That clock is in nearly every frame of this room, so there was always a
"pill" on screen waiting for a hand to pass near it.

Every guard downstream of the model is RELATIVE: overlap with a hand, size
against that hand (<35%), distance from the palm, a fingertip check. None of
them can see depth. A clock three metres away is small next to a hand held
close, in the flat projection the camera gives. This codebase has made exactly
that mistake before, when a phone lying on a bed was read as a phone in a hand
because it was large enough in frame.

So the ceiling is ABSOLUTE and derived from physical size, not fitted to these
two false positives: a 500mg tablet is about 13mm, the camera is 1280px across
roughly 70 degrees, so a tablet is about 24px at 50cm and about 40px at arm's
length. 5% of frame width is 64px -- past any way a hand holds a tablet up to
a chest camera, and under both the clock (71px) and the fan dial (108px).

It is NOT validated against a confirmed pill. There is no true-positive
evidence frame in this installation; the first real dose taken on camera is
what will confirm it, and that is stated here rather than glossed.

And the second half: rejecting a dose left the photograph on disk. The row was
marked rejected -- correctly, so "the camera once thought it saw an intake"
stays auditable -- but the picture of somebody lifting a laptop stayed in the
Keyframe Audit, filed as evidence of a dose they had just said did not happen.
The row stays and the image goes, exactly as the privacy purge separates them.
"""
import glob
import io
import os
import sys
import warnings

warnings.filterwarnings("ignore")

AI = r'C:\Users\dell\Desktop\LOCUS\ai_backend'
DP = os.path.join(AI, 'detection_pipeline')
BE = r'C:\Users\dell\Desktop\LOCUS\web_app\backend'
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import numpy as np

PASS = FAIL = 0


def check(label, cond, detail=""):
    global PASS, FAIL
    print(f"  {'PASS' if cond else '*** FAIL ***'}  {label}" + (f" -> {detail}" if detail else ""))
    if cond:
        PASS += 1
    else:
        FAIL += 1


import ai.detector as D

det_src = io.open(os.path.join(DP, 'ai', 'detector.py'), encoding='utf-8').read()
med_src = io.open(os.path.join(BE, 'routes', 'medication.js'), encoding='utf-8').read()
kf_src = io.open(os.path.join(AI, 'keyframe_backend', 'routes.py'), encoding='utf-8').read()

print("1. a pill has a size a pill can be")
check("there is an absolute ceiling", 0 < D.MAX_PILL_FRAC < 1, f"{D.MAX_PILL_FRAC} of frame width")
check("it is applied in the detector, so every phase benefits",
      "if max(x2 - x1, y2 - y1) > MAX_PILL_FRAC * orig_w:" in det_src)
check("  before the aspect filter and the NMS, not after",
      det_src.index("MAX_PILL_FRAC * orig_w") < det_src.index("Aspect ratio filter"))
check("it is settable without editing code", 'os.environ.get("MAX_PILL_FRAC"' in det_src)
check("the derivation is written down, not just the number",
      "13mm" in det_src and "70 degree" in det_src)
check("and so is the fact that it is unvalidated",
      "NOT validated against a confirmed pill" in det_src,
      "there is no true-positive frame in this installation to check it against")

W = 1280
ceiling = D.MAX_PILL_FRAC * W
print(f"     at {W}px wide the ceiling is {ceiling:.0f}px")
check("the wall clock (71px) is refused", 71 > ceiling or ceiling < 71, f"71 > {ceiling:.0f}")
check("the fan dial (108px) is refused", 108 > ceiling, f"108 > {ceiling:.0f}")
check("a tablet at arm's length (40px) is kept", 40 <= ceiling, f"40 <= {ceiling:.0f}")
check("a tablet at 50cm (24px) is kept", 24 <= ceiling)
check("  with room to spare, so it is not a knife edge", ceiling >= 40 * 1.5,
      f"{ceiling:.0f}px is {ceiling / 40:.1f}x the largest plausible tablet")

print()
print("2. on the frame it actually got wrong")
frames = glob.glob(os.path.join(AI, 'keyframe_backend', 'medications_storage',
                                '*', '*', 'aefe0344*.jpg'))
if not frames:
    print("     the evidence frame is gone -- it was deleted when the dose was rejected,")
    print("     which is the behaviour section 3 asserts. Replaying the model needs it,")
    print("     so this section is skipped rather than faked.")
else:
    import cv2
    img = cv2.imread(frames[0])
    found = D.PillDetector().detect(img)
    ds = found.get('detections', found) if isinstance(found, dict) else found
    check("the clock and the fan dial are no longer pills", len(ds) == 0,
          f"{len(ds)} detection(s)")

print()
print("3. rejecting a dose takes the photograph with it")
check("the rejection looks up the frames first",
      "const doomed = await EventLog.find(filter)" in med_src)
check("and asks the AI backend to destroy each one",
      "/api/keyframes/${encodeURIComponent(ev.keyframe_id)}" in med_src
      and "method: 'DELETE'" in med_src)
check("the row stays, and stays rejected",
      "verification_status: 'rejected'" in med_src and "EventLog.deleteMany" not in med_src,
      "the camera having once thought it saw an intake is the audit trail")
check("but it no longer points at a picture that is gone",
      "$unset: { keyframe_id: '' }" in med_src)
check("a failed delete does not fail the rejection",
      "could not delete frame" in med_src,
      "the row is rejected and hidden either way; a stray file is untidy, not wrong")
check("and the call cannot hang the request", "AbortSignal.timeout(" in med_src)

print()
print("4. the delete endpoint cannot be turned on somebody else")
check("it exists", '@router.delete("/{keyframe_id}")' in kf_src)
check("user_id is required", 'raise HTTPException(status_code=400, detail="user_id is required")' in kf_src)
check("and is checked against the sidecar, not trusted from the caller",
      'if owner and owner != str(user_id):' in kf_src)
check("the id is validated before it reaches a glob",
      're.fullmatch(r"[A-Za-z0-9_-]{4,64}"' in kf_src,
      "an id with .. in it would otherwise climb out of the store")
check("every store is covered, not just medication",
      all(s in kf_src[kf_src.index('@router.delete'):kf_src.index('@router.get("/storage")')]
          for s in ['KEYFRAME_STORAGE_DIR', 'MEDICATION_EVIDENCE_STORAGE_DIR',
                    'SOCIAL_STORAGE_DIR', 'ACTIVITY_STORAGE_DIR', 'ITEMS_STORAGE_DIR']))
check("and the rendered thumbnail too",
      "THUMB_CACHE_DIR, keyframe_id" in kf_src,
      "or the audit page keeps showing a frame that no longer exists")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
