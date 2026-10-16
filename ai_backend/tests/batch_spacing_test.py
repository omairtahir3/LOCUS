"""The medication batch must not starve the item indexer.

Two detectors share one machine. The medication batch runs in large synchronous
passes costing ~86 s of all-core work:

    [BatchAnalysis] YOLO batch: 60 frames in 69.8s
    [BatchAnalysis] Total inference: 60 frames in 86.6s

It was scheduled by FRAME COUNT -- BATCH_ANALYSIS_FRAMES, documented as "30 s at
5 FPS" -- while the real stream runs at 10 to 38 fps by the pipeline's own
heartbeats. So 150 frames arrive in four to fifteen seconds, the batch became
eligible several times more often than intended, and because _batch_busy is
released the instant a pass ends the next began immediately. A two-hour
medication window meant continuous saturation.

What the item indexer paid, from the live log:

    [DailyItemIndexer] backlog at 8; dropped 20 stale frame(s) so far
    [DailyItemIndexer] 8 frames queued, skipping the tile scan to catch up

and measured in the database: an item's event was written a median of 70 s and
up to 127 s after its frame was captured, while the frame itself reached the
Keyframe Audit in 4 s. That gap is what the wearer experienced as "two minutes
to detect an item after it gets logged".
"""
import io
import os
import re
import sys
import warnings

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


src = io.open(os.path.join(DP, 'ai', 'pipeline.py'), encoding='utf-8').read()

print("1. the interval is real time, not a frame count that assumes a frame rate")
check("there is a wall-clock minimum gap",
      'BATCH_ANALYSIS_MIN_GAP_SECONDS = float(' in src)
check("it defaults to the same window the frame count meant",
      'BATCH_ANALYSIS_MIN_GAP_SECONDS", BUFFER_SECONDS' in src,
      "30 s, which is what 'BUFFER_SECONDS * CAPTURE_FPS frames' was for")
check("and the gate consults it",
      '_gap_ok' in src and 'and _gap_ok' in src)

print()
print("2. it is measured from the END of the last pass")
check("the finish time is stamped in a finally block",
      re.search(r'finally:\s*\n\s*self\._batch_busy = False\s*\n'
                r'(\s*#[^\n]*\n)*\s*self\._batch_done_at = time\.time\(\)', src)
      is not None,
      "so a pass that throws still yields the gap; measuring from the START "
      "would let an 86 s pass outrun a 30 s interval and never pause")
check("the first pass is not delayed",
      '_batch_done_at = 0.0' in src,
      "arming a medication window must take effect at once")

print()
print("3. the frame condition is kept as well")
check("a slow stream still waits for a full window of frames",
      'frame_count - self._batch_last_analysis >= BATCH_ANALYSIS_FRAMES' in src,
      "otherwise the same frames would be analysed twice")

print()
print("4. the reason is recorded where the constant is")
check("the real frame rates are named",
      '10 to 38' in src and 'heartbeats' in src)
check("and the cost to the indexer is named",
      'median of 70 s' in src and 'audit in 4 s' in src,
      "so nobody re-tunes this back to a frame count")

print()
print("5. nothing about WHAT the batch looks for has changed")
check("the medication window still gates it",
      'has_active_medication' in src)
check("and a fully verified session still skips it",
      'all_meds_verified' in src)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
