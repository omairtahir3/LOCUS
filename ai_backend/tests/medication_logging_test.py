"""A dose the wearer took, from the frames that recorded it, through to logging.

The 07:15 Panadol was taken in front of the camera and nothing was recorded.
Their batch log held the whole story in 60 lines:

    [F48] pill=0.79 in_hand=True hands=1 pills_count=1
    [F49] pill=0.81 in_hand=True hands=1 pills_count=1
    [F50] pill=0.77 in_hand=True hands=1 pills_count=1
    ...
    [BatchAnalysis] No Phase 1 (pill in hand) from frame 0

Phase 1 searched "up to ~70% of remaining buffer to leave room for P2/P3",
which was frames 0..41 of 60. The only three pill-in-hand frames in the entire
buffer sat at 48, 49 and 50, inside the 18-frame reserve, so the search for a
pill in a hand walked past every frame that had one.

Section 1 replays those 60 frames through the REAL phase loop, read out of
pipeline.py as text, with the window as it is now and as it was. Then four
things the same log exposed downstream:

  * the "three passed phases are never missed" floor set the classification,
    while the logging branch re-derived its decision from the raw confidence
    and ignored it, so a complete sequence under 0.70 was still dropped;
  * the day's-memory frame labelled "Medication taken" was written for results
    that were then discarded -- a frame with nothing behind it;
  * the fallback claimed three passed phases, and announced it was "Sending to
    Gemini VLM for verification" to a VLM that does not exist in this repo;
  * self.user_id was assigned after the audio block that reads it, so every
    session disabled transcription with an AttributeError.
"""
import io
import os
import re
import sys
import textwrap
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

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


src = io.open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()

# ── the wearer's own 60 analysed frames ─────────────────────────────────────
# F#  pill  in_hand  hands  hand_y  motion  near_top  pills_count
LOG = """
0 0.33 F 1 0.41 0.16 F 0      30 0.00 F 0 1.00 0.00 F 0
1 0.62 F 2 0.19 0.30 T 0      31 0.00 F 0 1.00 0.00 F 0
2 0.25 F 1 0.51 0.19 F 0      32 0.00 F 0 1.00 0.00 F 0
3 0.34 F 1 0.65 0.19 F 0      33 0.00 F 0 1.00 0.00 F 0
4 0.26 F 1 0.66 0.19 F 0      34 0.00 F 0 1.00 0.00 F 0
5 0.00 F 1 0.47 0.22 F 0      35 0.00 F 0 1.00 0.00 F 0
6 0.43 F 0 1.00 0.00 F 0      36 0.00 F 1 0.20 0.78 T 0
7 0.21 F 1 0.45 0.22 F 0      37 0.26 F 1 0.19 0.78 T 0
8 0.52 F 0 1.00 0.00 F 0      38 0.34 F 1 0.18 0.78 T 0
9 0.66 F 1 0.44 0.25 F 0      39 0.00 F 1 0.19 0.75 T 0
10 0.50 F 1 0.43 0.25 F 0     40 0.36 F 1 0.21 0.75 T 0
11 0.50 F 1 0.43 0.25 F 0     41 0.00 F 0 1.00 0.00 F 0
12 0.41 F 1 0.44 0.28 F 0     42 0.00 F 0 1.00 0.00 F 0
13 0.27 F 0 1.00 0.00 F 0     43 0.34 F 0 1.00 0.00 F 0
14 0.00 F 1 0.29 0.72 F 0     44 0.00 F 0 1.00 0.00 F 0
15 0.53 F 1 0.23 0.75 T 0     45 0.00 F 0 1.00 0.00 F 0
16 0.48 F 1 0.23 0.75 T 0     46 0.00 F 0 1.00 0.00 F 0
17 0.48 F 1 0.23 0.75 T 0     47 0.00 F 0 1.00 0.00 F 0
18 0.39 F 1 0.19 0.75 T 0     48 0.79 T 1 0.62 0.35 F 1
19 0.31 F 1 0.17 0.75 T 0     49 0.81 T 1 0.62 0.32 F 1
20 0.00 F 0 1.00 0.00 F 0     50 0.77 T 1 0.66 0.28 F 1
21 0.00 F 1 0.05 0.78 T 0     51 0.00 F 0 1.00 0.00 F 0
22 0.00 F 1 0.06 0.81 T 0     52 0.00 F 0 1.00 0.00 F 0
23 0.00 F 1 0.06 0.81 T 0     53 0.00 F 0 1.00 0.00 F 0
24 0.00 F 1 0.05 0.81 T 0     54 0.00 F 1 0.34 0.28 F 0
25 0.00 F 1 0.04 0.81 T 0     55 0.00 F 0 1.00 0.00 F 0
26 0.00 F 0 1.00 0.00 F 0     56 0.84 F 2 0.35 0.28 F 0
27 0.00 F 1 0.06 0.81 T 0     57 0.70 F 2 0.22 0.32 F 0
28 0.00 F 0 1.00 0.00 F 0     58 0.00 F 1 0.24 0.32 T 0
29 0.00 F 0 1.00 0.00 F 0     59 0.00 F 1 0.20 0.32 T 0
"""


def frames():
    """The 60 frames, in order, with the fields the phase loop reads.

    near_top_score is the one field the log does not print. Here it is 1.0 for
    a near-top frame; the measured outcome is identical at 0.0, because Phase 2
    is reached through hand-disappearance and scores a flat 0.60 either way.
    """
    rows = []
    for ln in LOG.strip().split('\n'):
        t = ln.split()
        for off in (0, 8):
            i, pill, ih, hands, hy, mo, nt, cnt = t[off:off + 8]
            i = int(i)
            rows.append((i, {
                "best_pill": float(pill),
                "pill_in_hand": ih == 'T',
                "hands": int(hands),
                "hand_y": float(hy),
                "motion": float(mo),
                "near_top": nt == 'T',
                "near_top_score": 1.0 if nt == 'T' else 0.0,
                "in_hand_count": int(cnt),
                "kf": {"id": f"kf{i:02d}"},
                "frame": None,
                "timestamp": f"2026-10-16T07:30:{i:02d}",
            }))
    return [a for _, a in sorted(rows)]


class _Policy:
    auto_verify_threshold = 0.85
    confirmation_threshold = 0.70

    def legacy_classification(self, c):
        if c >= self.auto_verify_threshold:
            return {"classification": "auto_verified", "action": "log_automatically"}
        if c >= self.confirmation_threshold:
            return {"classification": "needs_confirmation",
                    "action": "request_user_confirmation"}
        return {"classification": "missed", "action": "discard"}


class _Stub:
    event_policy = _Policy()

    def classify_event(self, c):
        return self.event_policy.legacy_classification(c)

    def _attach_event_record(self, result, evidence=None):
        return result


def run_phase_loop(block):
    """Execute the real loop text against the wearer's frames."""
    ns = {"analyzed": frames(), "self": _Stub(),
          "PHASE2_MIN_PILL_CONF": float(
              re.search(r'PHASE2_MIN_PILL_CONF = ([\d.]+)', src).group(1)),
          "datetime": datetime, "timezone": timezone}
    out = io.StringIO()
    real, sys.stdout = sys.stdout, out
    try:
        exec(compile(block, '<pipeline-phase-loop>', 'exec'), ns)
    finally:
        sys.stdout = real
    return ns["results"], out.getvalue()


lines = src.split('\n')
_a = next(i for i, l in enumerate(lines)
          if 'Strict Sequential 3-Phase Detection' in l)
_b = next(i for i, l in enumerate(lines) if l.startswith('        if not results:'))
BLOCK = textwrap.dedent('\n'.join(lines[_a:_b]))

print("1. the dose in the wearer's frames reaches a loggable result")
results, out = run_phase_loop(BLOCK)
check("exactly one sequence is found", len(results) == 1,
      f"{len(results)} found; 48/49/50 are one grasp, not three")
if results:
    r = results[0]
    pd = r["phase_details"]
    conf = r["final_confidence"]
    check("Phase 1 is the strongest pill-in-hand frame",
          pd["phase1_medicine_visible"]["frame_index"] == 49,
          "frame 49 at pill=0.81, the best of 48/49/50")
    check("Phase 2 is the hand leaving view with the pill",
          pd["phase2_grip_and_motion"]["frame_index"] == 51,
          "frames 51-53 have no hand and no pill; the dose happened off-camera")
    check("Phase 3 is the hand back, empty",
          pd["phase3_medicine_gone"]["frame_index"] == 54,
          "frame 54: hand visible, pill 0.00")
    check("and it clears the confirmation bar",
          conf >= 0.70, f"confidence {conf}")
    check("without reaching auto-verify on its own",
          conf < 0.85,
          f"{conf} asks the wearer rather than recording it unasked")

print()
print("2. the 70% reserve was the cause, not a detail")
old_block = re.sub(
    r'( *)p1_search_end = len\(analyzed\) - 2',
    lambda m: (f"{m.group(1)}remaining = len(analyzed) - search_start\n"
               f"{m.group(1)}p1_search_end = min(len(analyzed), search_start "
               f"+ max(3, int(remaining * 0.7)))"),
    BLOCK)
check("the old bound is genuinely restored for this comparison",
      "int(remaining * 0.7)" in old_block)
old_results, old_out = run_phase_loop(old_block)
check("the same frames found NOTHING under it", len(old_results) == 0,
      "which is what the wearer's log printed")
check("and failed at Phase 1 specifically",
      'No Phase 1 (pill in hand) from frame 0' in old_out,
      "the three frames that had one were 48, 49, 50 -- past the 0..41 window")
check("the bound now follows the loop's own requirement",
      'p1_search_end = len(analyzed) - 2' in src,
      "two frames left for P2 and P3, which is what `while` already demands")
check("and the reason is recorded at the bound",
      'pill-in-hand frames in the' in src and '[F48] pill=0.79' in src)

print()
print("3. a complete sequence is logged, not just classified")
check("the logging branch consults the floor's decision",
      'elif _will_log:' in src,
      "it re-derived its own from the raw confidence and ignored the "
      "classification it was handed")
check("the floor is what _will_log consults",
      "classification == \"needs_confirmation\"" in src
      and 'phases_passed == 3' in src)
check("auto-verify keeps its own separate bar",
      'confidence >= self.event_policy.auto_verify_threshold' in src,
      "a floor must not promote anything to 'taken'")
check("and the earlier silent drop is named",
      '0.684 dose was' in src)

print()
print("4. the day's-memory frame follows the decision")
check("it is captured only for a dose being recorded",
      re.search(r'if _will_log:\s*\n\s*try:\s*\n\s*self\.extractor\.capture_event\(',
                src) is not None,
      "it ran for every result, including discarded ones")
check("and the frame with nothing behind it is named",
      'nothing behind it to open' in src)

print()
print("5. the fallback claims only what was seen")
check("no VLM is announced",
      'Gemini VLM for verification' not in src,
      "nothing was ever sent; Gemini is in the Node backend, for wording")
check("there is no VLM in the pipeline to send to",
      not re.search(r'^(?!\s*#).*[Gg]emini', src, re.M),
      "every remaining mention is a comment explaining its absence")
check("it reports one observed phase, not three",
      '"phases_passed": 1,' in src,
      "a pill was visible; the swallow was not")
check("the unobserved phases are marked as not passed",
      src.count('"score": 0.50, "pass": False,') == 2)
check("so it cannot be logged as an intake by phase count",
      '"phases_passed": 3,\n                    "min_phase_score": 0.50' not in src)
check("and why that mattered is written down",
      'fabricated doses from a pill lying on a desk' in src,
      "0.43 and 0.52 on frames with no hands in them at all")

print()
print("6. the audio block can see who it is protecting")
_assign = src.index('self.user_id = user_id')
_audio = src.index('if os.environ.get("AUDIO_CAPTURE"')
check("user_id is assigned before the audio block reads it",
      _assign < _audio,
      "it was assigned at the end of __init__, so every session printed "
      "AttributeError and transcription never ran")
check("it is assigned exactly once",
      src.count('\n        self.user_id = user_id') == 1,
      "a second assignment later would hide a re-ordering mistake")
check("the privacy check is still what governs the microphone",
      '_audio_allowed' in src and 'from ai.privacy import state as _ps' in src)
check("and the ordering is explained where it matters",
      'whom it is protecting' in src)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
