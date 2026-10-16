# AI backend tests

Run them all:

```
python ai_backend/tests/run_all.py
```

or one at a time — each is a standalone script:

```
python ai_backend/tests/moved_item_test.py
```

No pytest, no fixtures, no conftest. Every suite prints `N passed, M failed`
and exits non-zero on failure, and is meant to be read top to bottom as an
argument about the behaviour it checks, with the measurement that justified
each threshold written beside it.

## Why they live here now

They were written in a session scratchpad under `%TEMP%`, which is cleaned
between sessions. **Eight suites were lost that way** before anyone noticed:

```
audio_test           class_bar_test        no_spawn_test       one_per_frame_test
size_veto_test       skin_reject_test      duplicate_frames_test
tile_corroboration_test
```

They are gone, not misplaced — nothing on disk holds them. Whatever they
asserted about audio capture, the class-agreement bar, process spawning, the
one-sighting-per-frame rule, the pill size veto, skin rejection, duplicate
frames and tile corroboration is now unguarded. The behaviours still exist in
`detection_pipeline/ai/`; only the tests are missing, and they should be
rewritten when those areas are next touched.

One corner of the lost `audio_test` has since been re-covered, by
`medication_logging_test` section 6: that `self.user_id` is assigned before the
audio block reads it. It was not. Every session printed `Audio capture
disabled: AttributeError: ... has no attribute 'user_id'` and transcription had
never once run — exactly the kind of thing the lost suite would have caught the
day it broke.

## The thing to understand before trusting a green run

Many suites measure against the wearer's **real stored keyframes**, and those
expire on a 36-hour retention (`KEYFRAME_TTL_HOURS`). So a suite's evidence
disappears on a timer, and that shows up in three different ways:

1. **An honest skip.** `recover_test` detects that its window is past retention
   and checks the gate relationships it still can, saying so. Its assertion
   count drops from 6 to 3. Read "3 passed" as "3 of 6 were checkable", not as
   a full pass.
2. **A shrinking sample.** `adopt_sightings_test` measured 39 crops on 12 Oct
   and 13 after the sweep. Its assertions are absolute counts (`0 -> 1 wrong`),
   so it can fail purely because the evidence thinned.
3. **A moving total.** `blur_endtoend_test` 18 → 17, `region_proposer_test`
   27 → 23, `tile_enrolment_only_test` 11 → 8 across one day, with no code
   change. The suites are not flaky; their inputs are being deleted.

The fix is to commit a small set of fixture crops rather than reading live
storage, so the evidence stops evaporating. Until then, a failure in a
data-dependent suite deserves a check of whether its frames still exist before
it is treated as a regression.

## Timing assertions

Three timing bounds in this directory have had to be corrected for being set
too tight. `region_proposer_test` measured the same frame and code at 3.5s
alone, 9.1s with the live backend running, and 17.0s inside a full regression
run. Its bound is 25s and is documented as a **ceiling against a lost bound**,
not a performance target: losing the region proposer's cap or the verification
budget costs unbounded growth (140 verifications instead of 3 is three
minutes), not a factor of two. Please do not re-tighten these to the number
you happen to measure once.

## Suites that need a live service

- MongoDB on `127.0.0.1:27017` — most of them read `locusDB`.
- `privacy_test` and `auto_room_off_test` write and restore privacy settings on
  the calibration account; they clean up after themselves and say so.
- Nothing here needs the FastAPI backend to be running, and nothing writes to
  `keyframe_storage`. One probe once left an orphaned frame there by stubbing
  the database write but not the file write — if you add a suite that drives
  `_process_keyframe_task`, stub `_get_item_storage` too.
