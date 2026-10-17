# Chapter 5: Testing and Evaluation

Testing for LOCUS is in two layers. The first is an automated regression suite
that runs on one command and is the reason behaviour established once tends to
stay established. The second is the manual unit, functional, business-rule and
integration testing set out in §5.2 to §5.5, which covers the paths that need a
camera, a handset or a person in front of them.

Every threshold quoted in this chapter was read from the code, and every result
was produced by running the system rather than reasoning about it.

---

## 5.1 Automated Regression Suite

### 5.1.1 What exists

| Layer | Location | Scale | Runtime |
|---|---|---|---|
| AI backend and Node logic | `ai_backend/tests/` | **29 suites, 604 assertions** | 90 s |
| Flutter application | `mobile_app/test/` | **3 files, 11 tests** | 15 s |

```
python ai_backend/tests/run_all.py     ->  29/29 suites ok, 604 assertions passed, 0 failed
flutter test                           ->  All tests passed!
```

Each suite is a standalone script that prints `N passed, M failed` and exits
non-zero on failure; `run_all.py` is a thin wrapper rather than a framework.
There is no pytest, no fixtures and no conftest, which is a deliberate choice:
a suite can be run on its own and read top to bottom as an argument about the
behaviour it checks.

### 5.1.2 How the suites are written

Each suite opens with the measurement or the recorded log line that caused the
behaviour it guards, so that a reader can tell a deliberate threshold from an
accidental one before changing it. For example, `verifier_test.py` does not
merely assert that the verification threshold is 0.55; it asserts that the live
score distribution is recorded beside it, that the bar sits above every refusal
measured on this camera (0.516) and below the weakest true sighting (0.557), and
that the enrolment-quality figure of 0.961 is labelled as unrepresentative.

A threshold defended only by a number can be changed by anyone who measures it
once; a threshold defended by the evidence that set it cannot.

### 5.1.3 Honest skipping

Several suites measure against the wearer's real stored keyframes, which expire
on a 36-hour retention. Those suites detect that their evidence has aged out and
report SKIPPED rather than failing, because "the evidence expired" is not the
same as "the code regressed", and a suite that cries wolf every two days gets
ignored. A SKIPPED suite is therefore **not** a pass, and `run_all.py` labels it
as such.

This is visible in the totals: the same 29 suites reported 616 assertions on one
run and 604 on another with no code change between them, because the sample of
real frames available to the data-dependent suites had thinned. The suites are
not flaky; their inputs are being deleted on schedule.

### 5.1.4 What the suites cover

All 29 suites, grouped by the subsystem they defend. Assertion counts are from
the run quoted above; the suites marked † measure against the wearer's real
stored frames and skip when those have expired (§5.1.3).

**Belonging identification — 9 suites, 172 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `verifier_test.py` | 39 | Two-stage verification: the shortlisting bar is only relaxed where a verifier can actually adjudicate, every claim records whether it was checked, and the live score distribution is recorded beside the threshold |
| `near_miss_retry_test.py` † | 29 | A crop that nearly matched is looked at again under other lightings, and the retry asks for the bar that will really apply rather than the easiest one |
| `detector_class_test.py` | 26 | The detector's class label moves the bar in both directions but never decides identity on its own |
| `shape_tiebreak_test.py` | 25 | Box aspect ratio settles a tie only where the two items' shapes genuinely separate |
| `adopt_sightings_test.py` † | 16 | Gallery adoption is judged against enrolment, never against the grown gallery, and is capped and off by default |
| `one_spot_test.py` | 15 | One belonging cannot be in two places in one frame |
| `placement_test.py` | 13 | "In hand" means within reach of a hand, not merely a hand somewhere in the frame |
| `in_hand_needs_a_hand_test.py` | 11 | Size may doubt a grasp; it may not assert one with no hand in view |
| `tile_enrolment_only_test.py` † | 8 | A blind tile has no class, so it answers to enrolment and nothing else |

**Privacy, retention and evidence — 6 suites, 146 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `privacy_test.py` | 42 | Privacy Mode and the sensitive-room rule: capture refused before the cooldown slot is claimed, and the microphone governed by the same switch |
| `washroom_exit_test.py` | 31 | Two faults found the first time the rule ever fired on real footage |
| `privacy_trigger_test.py` | 27 | The rule must say what it saw, because it destroys the proof |
| `purge_confirm_test.py` | 16 | One frame may stop the camera; two are required before anything is destroyed |
| `blur_endtoend_test.py` † | 16 | Pressing "Blurred" produces a blurred frame on disk, not merely a blurred preview |
| `thumb_retention_test.py` | 14 | An expired frame takes its cached renderings with it |

**Scene, rooms and sessions — 4 suites, 83 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `auto_room_off_test.py` | 28 | The automatic room rule still watches when it is not allowed to act |
| `destructive_rooms_test.py` | 17 | Every room the wearer marks private is held to the harder bar, not only the washroom |
| `activity_store_test.py` | 19 | A closed session files its own evidence without removing the moment from the day's memory |
| `session_frame_test.py` | 15 | A room session never reaches memory search with a frame that no longer exists |

**Conversation and faces — 1 suite, 59 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `conversation_test.py` | 59 | One conversation is one person, one transcript, one summary — the largest single suite in the project |

**Medication — 4 suites, 69 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `medication_logging_test.py` | 27 | A dose from the frames that recorded it through to the log, including a differential check that the old search bound found nothing |
| `medication_fp_test.py` | 23 | A wall clock is not a pill, and a rejected dose keeps no photograph |
| `batch_spacing_test.py` | 10 | The medication batch must not starve the item indexer |
| `medication_phases_test.py` | 9 | Swallowing a pill hides it; the phase logic must not require otherwise |

**Pipeline, cost and recovery — 5 suites, 75 assertions**

| Suite | Assertions | What it holds to account |
|---|---:|---|
| `model_weight_test.py` | 27 | Two models' worth of weight removed with nothing that produced output lost |
| `region_proposer_test.py` † | 23 | Candidate regions are proposed by the frame rather than by a fixed grid, under a bounded verification budget |
| `moved_item_test.py` | 8 | A belonging is recognisable wherever it is put down, not only on one desk |
| `moved_item_window_test.py` | 8 | A move is recorded whenever it happens, not only inside the first window |
| `recover_test.py` † | 3 | Frames lost to an earlier gate are recoverable, measured against what still exists |

**Flutter — 3 files, 11 tests**

| File | What it holds to account |
|---|---|
| `widget_test.dart` | The app starts on the splash screen and moves to login with no session |
| `memory_refresh_test.dart` | The memory screen refreshes only while it is the visible tab |
| `stat_tile_overflow_test.dart` | The caregiver stat grid fits its text at 360 dp, at text scale 1.0 and 1.3 |


---

## 5.2 Unit Testing

Unit testing verifies the smallest testable components in isolation.

### 5.2.1 `is_pill_in_hand()` — spatial and logical validation

**Objective:** verify that the pipeline accepts a pill as *held* only when the
geometry supports it, since every later phase depends on this judgement.

The function applies four independent gates. All four thresholds below are the
values in `pipeline.py`.

| No. | Test case | Attribute and value | Expected result | Actual result |
|---|---|---|---|---|
| 1 | Pill overlapping hand, all gates satisfied | IoU ≥ 0.15, size ratio ≤ 0.35, confidence ≥ 0.40, palm distance ≤ 0.8 × hand diagonal | Accepted as in hand (True) | True |
| 2 | Object too large to be a tablet | Size ratio > 0.35 of hand area | Rejected (False) | False |
| 3 | Pill far from the palm centre | Palm distance > 0.8 × hand diagonal | Rejected (False) | False |
| 4 | Weak detection | YOLO confidence 0.25 (< 0.40) | Rejected (False) | False |
| 5 | Elongated object (pen, cable) | Aspect ratio > 3.5 | Rejected (False) | False |

Case 5 is the gate most often exercised in practice: a chest camera sees a great
many long thin objects at hand height, and shape alone discards them before any
confidence scoring takes place.

### 5.2.2 `_is_time_match()` — scheduling tolerance

**Objective:** verify that the scheduler recognises a dose time within tolerance,
including across the midnight boundary.

The function compares minute-of-day values and folds the difference with
`min(diff, 1440 - diff)`, giving a tolerance of **±180 minutes** by default.

| No. | Test case | Attribute and value | Expected result | Actual result |
|---|---|---|---|---|
| 1 | Exact match | Current 08:00, scheduled 08:00 (diff 0) | True | True |
| 2 | Inside tolerance | Current 09:30, scheduled 08:00 (diff 90) | True | True |
| 3 | Outside tolerance | Current 12:00, scheduled 08:00 (diff 240) | False | False |
| 4 | Across midnight | Current 01:00, scheduled 23:00 (folded diff 120) | True | True |
| 5 | Malformed input | Scheduled `"8"` with no minute field | False, without raising | False |

**A distinction worth stating,** because the two numbers are easily confused:
this ±180-minute tolerance decides whether a scheduler tick *recognises* a dose
slot. The **120-minute verification window** in §5.4 is a different quantity —
how long the system then watches for the dose to be taken.

### 5.2.3 `_class_agrees()` and `_match_threshold()` — identity bars

**Objective:** verify that the detector's opinion of *what* an object is moves
the similarity bar in both directions without ever deciding identity by itself.

| No. | Test case | Attribute and value | Expected result | Actual result |
|---|---|---|---|---|
| 1 | Detector class agrees with the enrolled item | Objects365 class matches the class measured on the item's own enrolment photos | Bar 0.65 | 0.65 |
| 2 | Detector class plainly disagrees | Class measured on enrolment does not match | Bar 0.85 | 0.85 |
| 3 | Faint box of an agreeing class | Detection confidence below the candidate floor | Bar raised to 0.75 | 0.75 |
| 4 | Agreeing class with a verifier available | Verifier gallery present and loadable | Bar relaxed to 0.55 | 0.55 |
| 5 | Relaxed bar, verifier did not run | Budget exhausted, so no check took place | Falls back to the strict bar; match refused | Refused |

Case 5 is the important one: a relaxed bar is licensed by a check, so if the
check does not happen the licence is withdrawn.

### 5.2.4 `_shape_usable()` — tie-breaking by outline

**Objective:** verify that shape resolves an ambiguous match only where the two
items' recorded aspect ranges genuinely separate.

| No. | Test case | Attribute and value | Expected result | Actual result |
|---|---|---|---|---|
| 1 | Disjoint aspect ranges | Phone 0.50–1.20, earbuds case 0.82–2.46, gap exceeded | Tie resolved by which range the live box falls in | Resolved |
| 2 | Overlapping ranges | The two ranges intersect | No resolution; neither item claimed | Neither claimed |
| 3 | One item has no recorded shape | Shape absent for one candidate | No resolution; neither claimed | Neither claimed |


---

## 5.3 Functional Testing

### 5.3.1 Three-phase medication detection

**Objective:** verify that a complete intake is recognised only when all three
phases occur in order, and that an incomplete action is not promoted to an
intake.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Complete intake sequence | P1 pill in hand → P2 hand rises → P3 pill gone | Sequence completes, evidence stored | Resolved P1 @49, P2 @51, P3 @54, confidence **0.837**, classified needs-confirmation, three evidence frames stored | Pass |
| 2 | Incomplete sequence | P1 only; pill picked up, not consumed | No event; buffer retains the frames | No sequence returned | Pass |
| 3 | Pill occluded during Phase 2 | P1 present, pill confidence 0.00 at P2 while hand rises | Sequence continues with a reduced score, not vetoed | Score reduced by 0.10, sequence completed | Pass |
| 4 | Complete sequence scoring below the bar | Three phases pass, aggregate < 0.70 | Floored at needs-confirmation, never discarded | Classification floored | Pass |

Case 1 is reproducible: the 60 recorded frames of a real dose are replayed
through the live search loop, so the result is a measurement rather than an
observation. Cases 3 and 4 exist because each was once a defect — see §5.6.

### 5.3.2 Manual rewatch

**Objective:** verify that a wearer or caregiver can re-run surveillance for a
slot that was missed or wrongly logged, without the scheduler overwriting it.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Trigger rewatch for a slot | Medication id supplied | Previous logs cleared, session created with `is_rewatch = True`, pipeline reset | Session initialised | Pass |
| 2 | Scheduler tick during an active rewatch | Scheduler runs while `is_rewatch` session is open | Scheduler does not override the session | Session preserved | Pass |

### 5.3.3 Privacy Mode and blurring

**Objective:** verify that the wearer's privacy controls take effect on disk,
not merely in the interface.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Privacy Mode on | Capture attempted while paused | No frame written; refusal logged with its reason | No file written | Pass |
| 2 | Blur mode on | Capture attempted while blurring | A frame is written and is genuinely blurred | Blurred frame on disk, verified by variance | Pass |
| 3 | Blur reaches derived frames | Item indexing runs on a blurred moment | The crop stored by the indexer is blurred too | Blurred | Pass |
| 4 | Refusal does not consume the cooldown | Capture refused by privacy | The next permitted frame is not skipped | Captured | Pass |

Case 4 was a real defect: a refused frame used to claim the cooldown slot, so
the first frame after privacy ended was silently dropped.

### 5.3.4 Belonging tracking

**Objective:** verify that a belonging is recognised wherever it is left, and
that a move is reported as a move.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Item seen in a new place | Same item, different position | Reported as moved, new position recorded | Moved | Pass |
| 2 | Item seen again in the same place | Position unchanged within tolerance | No duplicate event | Suppressed | Pass |
| 3 | Move after the first window | The move happens later in the day | Still recorded | Recorded | Pass |
| 4 | Same item twice in one frame | Two boxes both match one belonging | Only the better one kept | One kept | Pass |
| 5 | Two belongings claim one box | Scores within the ambiguity margin | Neither claimed unless shape separates them | Neither claimed | Pass |


---

## 5.4 Business Rules Testing

### 5.4.1 Medication window expiry

**Objective:** verify that the outcome written when a verification window closes
reflects both what was seen and whether the camera was there to see it.

**Window length: 120 minutes** (`window_minutes = 120`).

**Conditions.** C1 — was the camera connected during the window?
C2 — does the number of confirmed intakes equal the number expected?
C3 — were some but not all expected doses confirmed?

| No. | Conditions (C1, C2, C3) | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Yes, Yes, N/A | Camera connected, all doses confirmed | `taken` | `taken` | Pass |
| 2 | Yes, No, Yes | Camera connected, some doses confirmed | `needs_verification` | `needs_verification` | Pass |
| 3 | Yes, No, No | Camera connected, nothing confirmed | `missed` | `missed` | Pass |
| 4 | No, No, No | Camera never streamed during the window | `camera_off` | `camera_off` | Pass |

Case 4 matters more than it appears. A dose that was not watched is not the same
as a dose that was watched and not taken, and recording both as "missed" would
tell a caregiver that somebody skipped their medication when in fact nobody was
looking. The statuses written by the system are `taken`, `needs_verification`,
`missed`, `camera_off`, `skipped`, `scheduled` and `pending`.

### 5.4.2 Sensitive-room frame destruction

**Objective:** verify that a room the wearer has marked sensitive is acted on
only when the classification is certain, since acting means deleting frames.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Sensitive room, confident detection | Defining object ≥ 0.80 | Frames refused or destroyed | Refused | Pass |
| 2 | Sensitive room, marginal detection | Defining object 0.70 (≥ ordinary floor 0.55, < 0.80) | No action taken | No action | Pass |
| 3 | Ordinary room, same confidence | Defining object 0.70 in a non-sensitive room | Room named normally | Named | Pass |

Case 2 is the reason the raised floor exists: at the ordinary 0.55 bar, frames
recorded in an ordinary room were being destroyed on a marginal classification.

### 5.4.3 Destruction requires corroboration

**Objective:** verify the rule that governs the only action the system takes
that cannot be undone.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | One frame suggests a sensitive room | A single confident classification | Capture stops; nothing is deleted | Stopped only | Pass |
| 2 | Two frames agree | A second confident classification follows | Retroactive purge of that stretch | Purged | Pass |
| 3 | Automatic rule disabled | `AUTO_ROOM_PRIVACY` off | The rule still records what it would have done, and acts on nothing | Recorded only | Pass |

The asymmetry in cases 1 and 2 is deliberate: stopping the camera on one frame
costs a few seconds of recording if it is wrong, while deleting on one frame
costs the wearer a piece of their day that cannot be returned.


---

## 5.5 Integration Testing

### 5.5.1 Scheduler ↔ AI pipeline ↔ database

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Session creation | Slot due, expected count 2 | Pipeline receives `expected_medicine_count`, buffer cleared | Pipeline initialised with the slot's medication context | Pass |
| 2 | Detection written back | Pipeline confirms an intake | Count read back, log written to MongoDB | Log written | Pass |
| 3 | Wearer not streaming at dose time | No live stream for that user | Session recorded; pipeline starts when the camera does | Session held, pipeline started on stream arrival | Pass |

### 5.5.2 Evidence storage and retrieval

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Evidence written | Three-phase intake completes | Three frames written to `medications_storage` with `phase_role` sidecars | Frames and sidecars written under `<user_id>/<date>/` | Pass |
| 2 | Evidence retrieved | Dashboard requests an evidence image | Node proxies to the AI backend, which returns `image/jpeg`; Node pipes the bytes through | Image rendered | Pass |
| 3 | Offline sync | Client requests a local copy | Frames returned base64-encoded for local storage | Base64 payload returned | Pass |
| 4 | Rejected dose | Caregiver marks a dose not taken | Evidence frames for that dose deleted, scoped to the medication and a window around it | Frames deleted | Pass |

Cases 2 and 3 are deliberately separated: the evidence carousel is a **binary
pipe**, while the offline sync endpoint is the only path that base64-encodes.

### 5.5.3 Real-time signalling

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | Emergency fan-out | Wearer raises an emergency | Every linked caregiver receives `sos_alert` over Socket.IO | Received | Pass |
| 2 | Call offer relayed | Wearer calls a linked caregiver | `call:incoming` delivered into the caregiver's room | Verified with an independent client joined as the caregiver: `call:incoming` received with `sos: true` | Pass |
| 3 | Call between unlinked users | Caller and callee have no caregiver link | Relay refused, caller told rather than left ringing | `call:ended`, reason `not_permitted` | Pass |
| 4 | Push notification delivery | Server sends to a registered device token | Notification arrives on the handset | `[FCM Push] Successfully sent`, `NotificationManager: notify(...)` on the device | Pass |

Case 2 was tested by connecting a separate client to the running server
authenticated as the caregiver, which removes the dashboard from the question:
it establishes that the phone emitted and the server relayed, independently of
whether any browser rendered it.

### 5.5.4 Conversation, face and transcript

**Objective:** verify that a social interaction assembles into one record
rather than several, and that no transcript exists without a face.

| No. | Test case | Attribute and value | Expected result | Actual result | Result |
|---|---|---|---|---|---|
| 1 | One conversation, several frames | The same person recognised across a stretch | One event, one transcript, one summary | One record | Pass |
| 2 | No face recognised | Audio present, no face in any frame | No transcript written | None written | Pass |
| 3 | Privacy Mode during a conversation | Blur or pause active | Transcript refused along with the frame | Refused | Pass |
| 4 | Session frame expired | A room session's chosen frame deleted before the session closed | The session is written with a frame that still exists, or none | Surviving frame used | Pass |


---

## 5.6 Defects Found, and the Tests That Now Guard Them

The suites in §5.1 were not written in advance. Most exist because something
failed, and each encodes the evidence of that failure so it cannot recur
silently. This section is included because a test written after a defect is
better evidence of rigour than one written before.

| Defect observed | Cause | Test that now guards it |
|---|---|---|
| A real dose produced no event at all | Phase 1 searched only the first 70% of the buffer; the only pill-in-hand frames were 48–50 of 60 | `medication_logging_test.py` replays those 60 frames and additionally restores the old bound to prove it found nothing |
| Every genuine dose rejected at Phase 2 | The pill was required to stay visible while the hand rose; fingers occlude a 13 mm tablet | `medication_phases_test.py` |
| A complete sequence scoring 0.684 discarded in silence | The classification floor set a label the logging branch then ignored | `medication_logging_test.py` |
| Frames destroyed in an ordinary room | Sensitive-room classification acted at the ordinary 0.55 floor | `destructive_rooms_test.py`, `washroom_exit_test.py` |
| Expired frames left their rendered thumbnails on disk forever | Retention deleted the frame and sidecar only; 486 of 493 thumbnails were orphans | `thumb_retention_test.py` plants aged and fresh frames and sweeps them |
| A stat tile overflowed its grid cell by 10 px | Tile height derived from `childAspectRatio`, leaving 53 px for a 63 px column | `stat_tile_overflow_test.dart` renders the grid at 360 dp and at text scale 1.0 and 1.3 |
| One friend recorded as four unknown people | Frontality was advisory; five crops of the same person agreed at only 0.33–0.46 | Guarded in `conversation_test.py` |

---

## 5.7 Limitations of the Testing Performed

Stated so the evidence is not read as stronger than it is.

1. **No formal evaluation of face recognition.** No precision or recall figure
   against a labelled set exists for Supporting Module C; §4.2.3 reports the one
   failure mode that was measured and nothing more.
2. **Data-dependent suites decay.** Several suites measure against real stored
   frames that expire after 36 hours. They skip honestly, but a full-strength
   run requires recent footage, and the assertion total moves between runs for
   that reason alone.
3. **Eight suites were lost.** Eight earlier suites were written in a session
   scratchpad that was cleaned, and are recorded by name in
   `ai_backend/tests/README.md` as unguarded areas.
4. **No load or performance testing.** Latency figures quoted elsewhere are
   single-machine measurements taken during ordinary use, not the result of a
   controlled benchmark, and the system has never been run with more than one
   live wearer.
5. **UI testing is narrow.** Eleven Flutter tests cover start-up, a refresh path
   and one layout; there is no end-to-end UI automation, and the dashboard has no
   automated tests at all.
6. **The outdoor paths are untested.** Core FE-12 to FE-14 have never been
   exercised against outdoor footage, and their thresholds are labelled
   UNVALIDATED in the code.
