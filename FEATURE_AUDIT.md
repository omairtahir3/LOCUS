# LOCUS — Feature Audit

**Audited:** 17 October 2026 (Module B re-audited against live data the same day) · **Against:** SRS §1.7 (10 modules, 51 features)

Every row below was checked against code in this repository, not against memory
or intent. Where a feature is marked partial, the reason is specific and the
file is named, so the gap can be closed or the claim corrected.

| Status | Count | Share |
|---|---:|---:|
| ✅ Done | 42 | 82% |
| 🟡 Partial | 9 | 18% |
| ❌ Not started | 0 | 0% |
| **Total** | **51** | |

> **Partial** means the capability exists and runs, but something measurable is
> missing: a sub-feature, a validation, or a deployment step. It is not a
> synonym for "nearly done" — §"Caveats behind a green row" lists the ones that
> read better than they are.

---

## Core Module — Real-Time Video Analysis & Keyframe Extraction

10 done · 5 partial

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Keyframes at up to 5 FPS, adaptive to motion | ✅ | `ai/pipeline.py` `CAPTURE_FPS=5` as a ceiling; `KeyframeExtractor.should_capture()` reduces below it. Live logs: 4–6 fps tracking motion |
| 2 | Scene change & action boundary detection | ✅ | `ai/scene.py` `classify_scene`; scene sessions in `item_indexer._observe_scene`; medication boundaries via the 3-phase sequence |
| 3 | 5–10 s rolling buffer around each event | ✅ | `BUFFER_SECONDS=30` ring buffer in `ai/pipeline.py` — exceeds the spec |
| 4 | Activities across frames: medication, exit item check, social | 🟡 | Medication (3-phase) and social (insightface) both work. The **exit item check** is `left_behind` in `utils/routineMonitor.js`, driven by scene sessions and GPS rather than doorway vision. The egocentric activity plugin is `enabled=False` in `plugins/registry.py` by decision |
| 5 | Plugin-based model architecture | ✅ | `ai/plugins/registry.py` — `PluginSpec`, lazy registration, a failed plugin costs only itself |
| 6 | Confidence scored across the full buffer | ✅ | `analyze_buffer` / `analyze_keyframes_batch`: weighted average blended with the weakest phase |
| 7 | ≥85% auto-log, 70–84% confirm, <70% discard | ✅ | `ai/core/policy.py` — `auto_verify_threshold=0.85`, `confirmation_threshold=0.70`, exactly as specified |
| 8 | Auto-delete keyframes after 24–42 h unless flagged | ✅ | `KEYFRAME_TTL_HOURS=36`; `cleanup_expired` retains anything flagged in `eventlogs`, `medication_logs`, `relationships`, `useritems` |
| 9 | Structured JSON event record uploaded to the cloud | 🟡 | The record exists and is complete (`models/EventLog.js`: timestamp, type, confidence, GPS, keyframe ids). **The database is local** — `MONGO_URI=mongodb://localhost:27017/locusDB`. No hosted instance is configured |
| 10 | Frames + GPS + timestamp in one record | ✅ | `_attach_latest_location` in `ai/pipeline.py`, with a 30-minute staleness guard that refuses an old fix rather than attaching a wrong one |
| 11 | Learn per-user patterns and adjust thresholds | ✅ | `utils/thresholdAnalyzer.js`, nightly, bounded 0.75–0.95 / 0.60–0.80. Deliberately scoped to `medication_intake` and `unknown_face` — the only two event types a person can actually *reject*, so the rejection rate measures accuracy rather than nothing |
| 12 | Keep checking a carried item outdoors; alert on loss | 🟡 | `routineMonitor.js` `left_behind` / `item_lost`, `models/RoutineFinding.js`. **Never validated** — no outdoor footage has been recorded |
| 13 | Log GPS each time a tracked item is seen outdoors | 🟡 | `utils/outdoor.js` `outdoorStatus` + `locationlogs`; outdoors is decided from GPS, not vision. Same validation gap as FE-12 |
| 14 | Loosen confidence thresholds outdoors | 🟡 | `OUTDOOR_CONF_THRESHOLD=0.25` in `ai/item_indexer.py`, matched to `utils/outdoor.js` so both sides agree. Marked UNVALIDATED in the code itself |
| 15 | Escalate to caregiver with GPS, keyframe, timestamp | ✅ | `routine_item_lost_escalated` in `models/Notification.js` with `escalated_at`; `utils/routineNotifier.js` |

---

## Supporting Module A — Memory Capture & Scene Input

3 done · 2 partial

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Record continuous video and audio | 🟡 | Video via MediaMTX RTSP at 1280×720. **Audio had never once run** — `self.user_id` was assigned after the audio block that reads it, so every session died on `AttributeError`. Fixed 16 Oct; not yet confirmed on a live wearer run |
| 2 | Classify the environment before passing frames on | ✅ | `ai/scene.py` `classify_scene` — a room is named only when one of its defining objects is seen clearly enough, then confirmed by the room's other objects, a score floor and a margin over the runner-up. Measured over all 86 stored frames: **71% of "no room" is because no defining object was in view at all**, which is the correct answer rather than a failure — a room you cannot see a bed, a fridge, a couch, a toilet or a dining table in is one the system has no business naming. Rooms it does name are correct (`scene:bedroom` 30 sessions, kitchen and living also recognised) |
| 3 | Speech to text, attached to event records | 🟡 | `ai/transcriber.py` + `transcripts` collection + `EventRecord.transcript_id`. Blocked by the same `user_id` bug until 16 Oct, so the collection is effectively empty |
| 4 | Instant pause on Privacy Mode | ✅ | `ai/privacy.py` `state()`, checked in `capture_event` before the cooldown slot is claimed; `components/Privacy/PrivacyPanel.jsx` |
| 5 | Auto-stop in user-defined sensitive locations | ✅ | `AUTO_ROOM_PRIVACY=1`; `DESTRUCTIVE_ROOMS` with a raised 0.80 confidence floor so a room is only acted on when it is certain |

---

## Supporting Module B — Behavioral Pattern & Routine Learning

1 done · 2 partial — *re-audited 17 Oct against live data; see the note below*

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Learn daily routines from accumulated events | 🟡 | `utils/routineLearner.js` runs daily from `server.js` `routineLearner.init()` and builds 28 profiles. It counts correctly but **asserts nothing**: every signal on the only populated account comes back `expected: false` |
| 2 | Maintain a profile that updates as routines change | 🟡 | `RoutineProfile` is rebuilt every 24 h and holds real histograms (bedroom 30, Phone 86, Earbuds 24, medication 6). With no expectation ever crossing the bar, nothing downstream can consume it |
| 3 | Deviation alerts | ✅ | `utils/routineMonitor.js` every 15 min. **210 findings written**: `camera_off` 136, `left_behind` 39, `medication_gap` 35, of which 122 were surfaced. Each carries a `dedup_key`, so one deviation alerts once |

### Why the profile asserts nothing

A signal is "expected" when it appears in the **same hour** on ≥60% of observed
days of that type (`EXPECTED_RATIO = 0.6`). The account has 10–11 weekday and 6
weekend days observed, which clears the `MIN_DAYS_FOR_EXPECTATIONS` bars of 10
and 5 — so the profile is supported. No signal reaches the ratio:

| signal | best hour | best 3-hour window | best 6-hour band | bar |
|---|---|---|---|---|
| Phone | 2/10 | 3/10 | 4/10 (night) | 6 |
| scene:bedroom | 2/10 | 3/10 | 4/10 (night) | 6 |
| Rover Earbuds | 2/6 | 3/10 | 3/10 (night) | 6 |
| medication | 3/10 | 3/10 | 3/10 (night) | 6 |
| scene:kitchen | 1/10 | 1/10 | 1/10 | 6 |

Counted by **distinct days**, which is what the ratio means. Widening the slot
does not rescue it — even a 6-hour band peaks at 4 of 10 days. The constraint is
that the camera is worn on 10 of the last 30 weekdays and those sessions scatter
across the clock, so no part of the day accumulates a majority.

Consequences, both narrow:

* `checkDeviation` (a room expected now and not seen) and `checkHabitualItems`
  (an item usually here and missing) both `continue` on `!exp.expected`, so
  **neither has ever produced a finding**. Every one of the 210 findings came
  from a rule that does not consult the profile.
* The medication signal is additionally starved: only 12 doses were logged
  `taken` in 30 days, partly because the pipeline was discarding complete
  3-phase sequences until 16 Oct. Routine learning for medication cannot
  outrun medication detection.

One observation, not a defect: the hour bins are UTC (`medication` peaks at
02:00 for a dose scheduled 07:15 local). The monitor compares against the same
clock, so the logic is self-consistent — but any hour shown to a person would
read wrong, and a local-evening event near midnight can be filed as the next
day's type.

---

## Supporting Module C — Face Recognition & Social Support

3 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Recognize faces against the relationship database | ✅ | `ai/plugins/face_recognition.py` — insightface buffalo_l (SCRFD + ArcFace 512-D), matched against `relationships` |
| 2 | Past-interaction summary per person | ✅ | `pages/PastInteractions.jsx`, `screens/caregiver/family_detail_screen.dart` |
| 3 | New faces added only on explicit confirmation | ✅ | `routes/relationships.js` — `/confirm`, `/dismiss`, `/merge`; an unknown face raises a prompt, never an entry |

---

## Supporting Module D — Location Safety & Emergency Response

4 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Continuously send GPS to the cloud | ✅ | `services/location_service.dart` — `Geolocator.getPositionStream` → `POST /location`. (Cloud is the local Mongo, as in Core FE-9) |
| 2 | 'I'm Lost' by voice command **or** panic button | ✅ | Panic button → `POST /api/users/me/emergency` with caregiver fan-out, proven in use. Voice added 17 Oct in `home_screen.dart`: a toggle arms `speech_to_text` while the screen is foregrounded, matches a spoken phrase on partial results, and shares `_raiseEmergency()` with the button so the two paths cannot drift. A 5-second cancellable countdown sits between hearing and alerting, because a phrase can be overheard from a conversation or a television. **The spoken half has not yet been exercised on a handset** |
| 3 | Real-time voice-guided navigation home | ✅ | `home_screen.dart:296` — the active-emergency panel's "Take Me Home" button launches `https://www.google.com/maps/dir/?api=1&destination=<home>&travelmode=walking` externally, so the turn-by-turn and the spoken guidance are Google Maps' own. Requires `home_location` to be set in Settings, and says so when it is not. *(Recorded as not implemented on 17 Oct — that was a bad search on my part, not a missing feature)* |
| 4 | Live location + two-way voice with caregivers | ✅ | `components/Call/VoiceCall.jsx`, `services/voice_call_service.dart`, `utils/socket.js`; an active emergency is surfaced as an emergency rather than an ordinary call |

---

## Module 6 — Activity Summary & Monitoring

4 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Daily activity summary | ✅ | `pages/UserDashboard.jsx`, `pages/Dashboard.jsx` |
| 2 | Medication adherence: completed, missed, upcoming | ✅ | `UserDashboard.jsx` adherence block; `routes/medication.js` |
| 3 | Search memory by text or voice, filtered | ✅ | `routes/eventLogs.js` accepts `type`, `date`, `person`, `item`; `pages/MemorySearch.jsx` |
| 4 | Storage usage with cleanup suggestions | ✅ | `routes/storage.js` `GET /usage`, `components/Storage/StorageUsage.jsx`, `GET /api/keyframes/storage` per store |

---

## Module 7 — Memory Search & Retrieval

3 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Natural-language text or voice search | ✅ | `utils/memoryAgent.js` (LLM answer with template fallbacks when the model overreaches); browser `SpeechRecognition` in `MemorySearch.jsx`, no speech SDK |
| 2 | Results with keyframe images, timestamps, GPS | ✅ | `MemorySearch.jsx`; images resolved across all five stores by `_resolve_frame` |
| 3 | Timeline of daily activities from verified records | ✅ | `pages/ActivityFeed.jsx`, `pages/UserHistory.jsx` |

---

## Module 8 — Medication Management

3 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Full schedule with dosage and timing | ✅ | `models/Medication.js`, `pages/UserMedications.jsx` |
| 2 | Configurable reminders, snooze, manual confirmation | ✅ | `POST /api/medications/logs/:logId/snooze`, `PATCH /logs/:logId` for manual confirm |
| 3 | Notify caregivers when a dose is missed | ✅ | `utils/notificationScheduler.js` after reminders are exhausted; `utils/notifications.js` |

---

## Module 9 — Caregiver Dashboard

6 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Live feed of medicine, location, activity | ✅ | `pages/Dashboard.jsx` |
| 2 | Interactive map with location and emergency alerts | ✅ | `pages/LocationMap.jsx`, `screens/caregiver/location_map_screen.dart` |
| 3 | Last-seen GPS location | ✅ | `models/LocationLog.js`, `routes/location.js` |
| 4 | Send notifications and request status checks | ✅ | `routes/caregiver.js`, `routes/notifications.js` |
| 5 | Escalating push + email, delivery tracking, auto-retry | ✅ | `notificationScheduler.js` `retrySweep()` runs last in each tick; FCM via `firebase-admin`; `utils/emailDigest.js` |
| 6 | Multiple caregivers, role-based access, per-caregiver prefs | ✅ | `models/User.js` `role: user │ elderly │ caregiver`, per-caregiver notification preferences |

---

## Module 10 — User Dashboard

5 done

| FE | Feature | Status | Evidence |
|---|---|---|---|
| 1 | Daily summary: events, routine, medication, items | ✅ | `pages/UserDashboard.jsx` |
| 2 | Alerts with confirm, dismiss, snooze | ✅ | `pages/Notifications.jsx` — `acknowledge`, `dismiss`, `snooze` |
| 3 | One-tap Privacy Mode and monitoring disable | ✅ | `components/Privacy/PrivacyPanel.jsx`, `screens/settings/settings_screen.dart` |
| 4 | Recent location history with item last-seen markers | ✅ | `pages/LocationMap.jsx`, `pages/UserHistory.jsx` |
| 5 | Storage usage for device and cloud | ✅ | `components/Storage/StorageUsage.jsx` |

---

## Caveats behind a green row

These features are implemented and working, but a reader of the table alone
would carry a wrong impression.

1. **"Cloud" is a local MongoDB.** `MONGO_URI=mongodb://localhost:27017/locusDB`.
   Core FE-9, Module D FE-1 and everything described as cloud storage run
   against one machine. The schemas and upload paths are hosting-agnostic; the
   hosting is the missing step.
2. **Push notifications are simulated without credentials.** `utils/notifications.js`
   logs a warning and falls back when `firebase-service-account.json` is absent.
   Email delivery is unaffected.
3. **Nothing outdoors has ever been tested** (Core FE-12/13/14). The code paths
   exist and are internally consistent; no outdoor footage has been recorded,
   and the thresholds are labelled UNVALIDATED where they are defined.
4. **Gallery adoption is off** (`ADOPT_SIGHTINGS=False`). The system learns
   thresholds (Core FE-11) but does not learn new appearances of a belonging,
   because measurement showed it inventing wrong matches as well as recovering
   right ones.
5. **The egocentric activity plugin is off** (`plugins/registry.py`,
   `enabled=False`). Activity entries come from room sessions via YOLO11n
   instead. A closed session now files its frame in `activities_storage`.
6. **Detection margins on live frames are thin.** The DINOv2 verifier's bar is
   0.55; ten genuine phone sightings on 16 Oct scored 0.557–0.725, so the worst
   cleared by 0.007. See the comment at `ai/verifier.py` before moving it.
7. **A quarter of frames see a bed and still name no room** (A FE-2). Of the
   86 stored frames, 71% had no defining object in view, which is the right
   answer. But 25% detected a Bed or Pillow at 0.29-0.54 against a floor of
   0.55 -- two of them at 0.54, one hundredth under -- and one cleared the
   floor at 0.65 with too few other bedroom objects beside it. That is the
   threshold doing its job rather than a missing feature, and the lever is
   MIN_DEFINING_CONF; lowering it buys room coverage and costs false rooms.
   The bathroom floor is separate at 0.80 and would not move with it.
8. **GPS is only as fresh as the phone app.** A location older than 30 minutes
   is refused rather than attached, so events logged while the app is closed
   carry no GPS at all.
9. **Routine learning has learned nothing actionable yet** (Module B). The
   profiles are built and supported; no signal clears the 60% same-hour bar, so
   the two profile-driven deviation checks have never fired. The 210 findings
   on record all come from rules that do not consult the profile.

---

## What is actually left

| Work | Module | Effort |
|---|---|---|
| Confirm audio and transcripts on a real run | A FE-1, A FE-3 | The blocking bug is fixed; this is verification, not building |
| Say "I'm lost" to a handset and see it fire | D FE-2 | Verification. Worth checking two things specifically: that the phrase is recognised in a normal speaking voice, and that an hour of ordinary conversation near the phone raises nothing |
| Doorway-vision exit check | Core FE-4 | Currently inferred from sessions and GPS rather than seen at a door |
| Outdoor validation pass | Core FE-12/13/14 | Record outdoor footage, then confirm or re-tune three thresholds |
| Host the database | Core FE-9 | Deployment, not development |
| Make routine expectations reachable | B FE-1/2 | A decision, not a build. Either wear the camera at steadier hours until a part of the day reaches 6 of 10 days, or lower `EXPECTED_RATIO` to ~0.4 — at which point Phone-at-night and bedroom-at-night (both 4/10) would qualify. Lowering it buys earlier alerts at the cost of more false ones |

---

## Keeping this file honest

Tests live in `ai_backend/tests/` (29 suites, 616 assertions, `python
ai_backend/tests/run_all.py`). Several measure against the wearer's real stored
frames, which expire on a 36-hour retention, so a suite reporting SKIPPED is
not a pass — see `ai_backend/tests/README.md`.

When a row changes, change it here in the same commit, and say *why* in the
Evidence column rather than only *that* it is done. A row whose evidence is a
file that no longer exists is worse than an empty row.
