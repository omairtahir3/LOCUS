"""Which frames are kept, and whose dose they belong to.

The policy, set 23 October 2026:

    auto-verified        always stored
    needs_verification   stored, and destroyed if a person says it was not taken
    below the bar        never stored

An earlier pass stored three frames whenever a pill was seen and no intake was
claimed, under its own status. That is now removed. It was defensible as a
diagnostic -- it is how the tablet the model cannot see was found at all -- but
a refused detection is not evidence of anything, and keeping photographs of a
wearer for events that never happened is the wrong default for a camera that
lives in someone's bedroom.

The second half of this suite covers the part that makes rejection honest.
Evidence used to be matched for deletion by medication_id plus a time window,
and this wearer takes Panadol at 03:00, 03:15, 03:55, 05:10 and 05:15 -- gaps
of fifteen minutes, which no window can separate, so rejecting one dose could
destroy the pictures of another. The sidecar now records which dose rows it is
evidence of, and deletion names the dose.
"""
import json
import os
import shutil
import sys
import warnings

warnings.filterwarnings("ignore")

AI = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DP = os.path.join(AI, 'detection_pipeline')
os.chdir(DP)
sys.path.insert(0, DP)
sys.path.insert(0, AI)

import numpy as np

PASS = FAIL = 0


def check(label, ok, detail=""):
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"  PASS  {label}" + (f" -> {detail}" if detail else ""))
    else:
        FAIL += 1
        print(f"  FAIL  {label}" + (f" -> {detail}" if detail else ""))


print("Evidence policy: what is kept, and for which dose\n")

from ai.pipeline import MedicationDetectionPipeline as P
from keyframe_backend.keyframe import MEDICATION_EVIDENCE_STORAGE_DIR

TEST_USER = "0000000000testpolicy0001"
user_dir = os.path.join(MEDICATION_EVIDENCE_STORAGE_DIR, TEST_USER)
shutil.rmtree(user_dir, ignore_errors=True)


def frame(seed):
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, (720, 1280, 3), dtype=np.uint8)


def evidence():
    return [
        {"id": f"pol-{i}", "frame": frame(i), "timestamp": "2026-10-23T03:00:0%d+00:00" % i,
         "phase_role": r, "phase_order": i, "frame_index": 10 + i}
        for i, r in enumerate(["phase1_pill_visible", "phase2_grip_motion",
                               "phase3_pill_gone"], start=1)
    ]


def result(phases, conf):
    return {
        "timestamp": "2026-10-23T03:00:00+00:00",
        "final_confidence": conf,
        "frames_analyzed": 60,
        "classification": "verified" if conf >= 0.85 else "needs_confirmation",
        "phase_details": {
            "phase1_medicine_visible": {"score": conf, "pass": True, "best_pill": 0.8,
                                        "pill_in_hand": True, "in_hand_count": 1,
                                        "keyframe_id": "pol-1", "frame_index": 11},
            "phase2_grip_and_motion": {"score": conf, "pass": True, "motion": 0.7,
                                       "hand_y": 0.15, "keyframe_id": "pol-2",
                                       "frame_index": 12},
            "phase3_medicine_gone": {"score": conf, "pass": True, "pill_after": 0.1,
                                     "pill_drop": 0.7, "keyframe_id": "pol-3",
                                     "frame_index": 13},
            "phases_passed": phases, "min_phase_score": conf, "weighted_avg": conf,
        },
    }


def stored():
    out = []
    for root, _d, files in os.walk(user_dir):
        out += [os.path.join(root, f) for f in files if f.endswith('.jpg')]
    return out


def sidecars():
    out = []
    for root, _d, files in os.walk(user_dir):
        for f in files:
            if f.endswith('.json'):
                try:
                    out.append(json.load(open(os.path.join(root, f), encoding='utf-8')))
                except Exception:
                    pass
    return out


pipe = P.__new__(P)
pipe.user_id = TEST_USER
pipe.medication_ids = []
pipe.session_id = None
pipe._last_log_ids = ["LOG_FOR_THE_0300_DOSE"]

# ── 1. an auto-verified dose is always stored ─────────────────────────────
pipe._tag_detection_keyframes(result(3, 0.91), 0.91, "taken", frames=evidence())
check("an auto-verified dose stores its evidence", len(stored()) >= 3,
      f"{len(stored())} frame(s)")
metas = sidecars()
check("and the sidecar names the dose it is evidence of",
      any(m.get("medication_log_ids") == ["LOG_FOR_THE_0300_DOSE"] for m in metas),
      "so a rejection can find exactly these and nothing else")
check("and records that it was taken, not merely seen",
      any(m.get("detection_status") == "taken" for m in metas))

shutil.rmtree(user_dir, ignore_errors=True)

# ── 2. a dose awaiting confirmation is stored too ─────────────────────────
pipe._last_log_ids = ["LOG_FOR_A_DOSE_AWAITING_AN_ANSWER"]
pipe._tag_detection_keyframes(result(3, 0.74), 0.74, "needs_verification",
                              frames=evidence())
check("a dose awaiting confirmation stores its evidence", len(stored()) >= 3,
      f"{len(stored())} frame(s) — a person has to look at something")
check("and it is labelled as unconfirmed, never as taken",
      all(m.get("detection_status") == "needs_verification" for m in sidecars()))

shutil.rmtree(user_dir, ignore_errors=True)

# ── 3. nothing below the bar is stored at all ─────────────────────────────
src = open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()
check("a detection below the confirmation bar stores no frames",
      "pill_seen_no_intake" not in src,
      "the review-evidence path is removed")
check("evidence is written only from the two logging branches",
      src.count("self._tag_detection_keyframes(") == 2,
      f"{src.count('self._tag_detection_keyframes(')} call sites: taken and needs_verification")
check("and a frame for the day's memory is still gated on a recorded dose",
      "if _will_log:" in src)

# ── 4. rejection names the dose ───────────────────────────────────────────
routes = open(os.path.join(AI, 'keyframe_backend', 'routes.py'), encoding='utf-8').read()
check("the delete endpoint accepts a dose id",
      "medication_log_id: str = \"\"" in routes)
check("and matches it against the ids the sidecar recorded",
      'str(medication_log_id) not in sidecar_logs' in routes)
node = open(os.path.join(os.path.dirname(AI), 'web_app', 'backend', 'routes',
                         'medication.js'), encoding='utf-8').read()
check("and a rejected dose sends its own id",
      "qs.set('medication_log_id', String(logId))" in node)
check("a dose marked not taken withdraws its evidence",
      "status === 'missed' || req.body.status === 'skipped'" in node
      and "rejectIntakeEventLog(log.user_id, log._id)" in node)

shutil.rmtree(user_dir, ignore_errors=True)
check("test evidence cleaned up", not os.path.isdir(user_dir))

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
