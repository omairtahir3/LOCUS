# LOCUS — FYP 60% Implementation Evaluation

Slide-by-slide content. **[O]** = Omair presents, **[T]** = Taqdees presents,
**[Both]** = either.

The split follows the system's own boundary: Omair owns the Python inference
service and everything that happens to a frame; Taqdees owns the Node
application, the two clients and everything that happens to an event once it
exists. Medication is the one deliberate seam, and is presented as such.

Two slides are marked **FILL IN** — the individual contribution and LLM
disclosure slides. Only you two can state those truthfully; everything else on
these slides is taken from the codebase and can be opened live if the panel
asks.

---

## Slide 1 — Title and team **[Both]**

**LOCUS**
An AI wearable-camera system for elderly and dementia care

| Member | Role |
|---|---|
| Muhammad Omair Tahir | AI and perception: detection pipeline, object and pill detection, belonging identification, face recognition, scene classification, transcription, privacy and retention |
| Taqdees | Application and platform: REST API, authentication, notifications and scheduling, routine learning, real-time channel, caregiver dashboard, mobile application |

FYP 60% Implementation Evaluation · 18 October 2026

---

## Slide 2 — Problem statement **[T]**

A person with early dementia loses the thread of their own day. The losses are
specific and they compound:

- **"Did I take my tablet?"** — The dose is either taken twice or not at all. Neither the person nor the family can tell afterwards which happened.
- **"Where did I put my keys?"** — An hour of searching, several times a day.
- **"Who was that?"** — A visitor's name is gone by the time they sit down.
- **"What did I do today?"** — No account of the day exists to give a family member who asks.

**The actors:**

| Actor | What they need |
|---|---|
| Elderly user (the wearer) | To be reminded, to find their things, to get home, to reach someone |
| Normal user | The same record of their own day, without a caregiver attached |
| Caregiver / family | To know a dose was taken without phoning to ask; to be reached in an emergency |

**Why existing options do not solve it.** A pill dispenser proves a compartment
opened, not that a tablet was swallowed. A tracker tile must be attached to
every object in advance. A camera that uploads a household's video to a cloud
provider is a privacy cost most families will not accept.

---

## Slide 3 — Proposed solution **[T]**

A chest-mounted camera streams the wearer's day to a machine in their own home.
Nothing leaves the house.

The system answers four questions, from evidence rather than from the wearer's
memory:

1. **Was the dose taken?** Three phases are required — reaching for the
   container, the pill in hand, the hand to the mouth — before a dose is
   recorded, and the frames that justified it are kept as evidence a caregiver
   can inspect.
2. **Where is my belonging?** The wearer photographs an object once; it is then
   recognised wherever it is put down, and they are told which room they left
   it in.
3. **Who was that?** A face is matched to a relationship the wearer has
   confirmed. An unknown face is never added on its own.
4. **What happened today?** Room visits, belongings, conversations and doses
   form a searchable record, answerable in natural language.

**The privacy position is the design, not a feature bolted on.** All inference
is local. Every stored frame is deleted after thirty-six hours unless a
caregiver flags it. Conversation audio is transcribed in memory and never
written to disk. The wearer can pause capture or blur it entirely, and a room
they mark sensitive causes the footage recorded there to be destroyed.

---

## Slide 4 — Architecture **[O]**

```
   Wearable camera ──RTMP over Wi-Fi──▶ MediaMTX ──RTSP per user──▶
   
   ┌──────────────────────────────────────────────────────────┐
   │  PYTHON INFERENCE SERVICE   (FastAPI · :8000)            │
   │  object detection · pill detector · hand landmarks       │
   │  belonging identification · face recognition             │
   │  scene classification · transcription                    │
   │  privacy enforcement · 5 evidence stores · 36 h sweeper  │
   └───────────────────────────┬──────────────────────────────┘
                               │ HTTP (events, metadata)
   ┌───────────────────────────▼──────────────────────────────┐
   │  NODE APPLICATION   (Express · :5000)                    │
   │  11 route modules · JWT auth · role authorisation        │
   │  schedulers: 60 s tick · routine monitor 30 s            │
   │  notifications: FCM + SMTP, 3 retries                    │
   │  Socket.IO: one room per user                            │
   └──────┬────────────────────────────────┬──────────────────┘
          │ REST + Socket.IO               │
   ┌──────▼─────────┐              ┌───────▼──────────┐
   │ Flutter app    │◀─WebRTC────▶ │ React dashboard  │
   │ (Android)      │  audio P2P   │ (caregiver)      │
   └────────────────┘              └──────────────────┘
          
   MongoDB (local) ── structured data · 14 collections
```

**Three points to make aloud:**

- It is **two services on one machine**, not microservices. The split is a
  runtime boundary — the models are Python, the application logic is Node — not
  an organisational one.
- The **phone is not in the video path.** The camera publishes straight to the
  stream server; the handset never receives a frame it did not request for
  display.
- **Voice call audio bypasses the server entirely** and is the only encrypted
  transport currently in use.

---

## Slide 5 — Modules **[Both: O presents 1–4, T presents 5–10]**

| # | Module | What it does |
|---|---|---|
| Core | Real-time video analysis and keyframe extraction | Reads the stream at up to 5 fps, selects frames worth keeping, runs every detector over a rolling buffer, scores confidence, enforces privacy and deletes after 36 h |
| A | Memory capture and scene input | Classifies the room from a defining object, groups classifications into room sessions, captures conversation audio into a 30-second in-memory buffer and transcribes it |
| C | Face recognition and social support | Detects faces, embeds them, matches against the wearer's confirmed relationships, and asks before enrolling anyone new |
| 7 | Memory search and retrieval | Answers a natural-language question about the day from indexed event records, with the frames that support the answer |
| B | Behavioural pattern and routine learning | Builds a profile from a 30-day baseline, rebuilt daily, and compares the current day against it every 30 seconds |
| D | Location safety and emergency response | Home-radius check, button and spoken emergency, escalation to every linked caregiver, route home by Maps handoff |
| 6 | Activity summary and monitoring | Assembles the day into a feed and a summary, per person and per date |
| 8 | Medication management | Schedules, reminders, the 2-hour verification window, dose records with evidence, missed-dose escalation |
| 9 | Caregiver dashboard | Family list, per-person emergency screen, activity feed, keyframe audit, relationship management, storage report, chat, voice call |
| 10 | User dashboard | The wearer's own day: reminders, belongings, memory search, step count, privacy controls |

---

## Slide 6 — Tools and technologies **[O]**

| Technology | Version | Purpose |
|---|---|---|
| YOLO11n / Objects365 via Ultralytics | 8.4.14 | Object detection, 365 classes — candidate regions and room vocabulary |
| ONNX Runtime | 1.24.2 | Single-class pill detector at 640×640 |
| MediaPipe Hands | 0.10.14 | 21 hand landmarks — is the pill actually in a hand |
| MobileNetV3-Small + DINOv2 ViT-S/14 (timm) | 1.0.29 | Two-stage belonging identification |
| InsightFace buffalo_l | 1.0.1 | Face detection and 512-D embeddings |
| faster-whisper | 1.2.1 | Speech transcription, text only |
| OpenCV | 4.13.0 | Decode, frame selection, blurring, JPEG encode |
| PyTorch | 2.10.0 | Runtime for the embedding models |
| FastAPI / Uvicorn | 0.136.1 / 0.30.1 | Inference service HTTP interface |
| MediaMTX | — | RTMP ingest, RTSP republish per user |

---

## Slide 7 — Tools and technologies, continued **[T]**

| Technology | Version | Purpose |
|---|---|---|
| Node.js / Express | 22.22.3 / 4.19.2 | Application API, 11 route modules, background schedulers |
| MongoDB + Mongoose | local / 8.4.0 | 14 collections; schema validation and connection pooling |
| Socket.IO | 4.8.3 | Real-time alerts, chat and call signalling; one room per user |
| Flutter / Dart | 3.35.3 / 3.9.2 | Mobile application, both roles |
| React / Vite | 19.2.0 / 6.4.1 | Caregiver dashboard |
| firebase-admin (FCM) | 14.1.0 | Push notifications |
| nodemailer (SMTP) | 6.9 | Email, the second independent channel |
| flutter_webrtc | 1.6.2 | Peer-to-peer call audio |
| jsonwebtoken / bcryptjs | 9.0.2 / 2.4.3 | Authentication and password hashing |
| @react-google-maps/api | 2.20.8 | Location map and route handoff |

---

## Slide 8 — Module completion status **[Both]**

Audited feature by feature against the code. 51 features total.

| Status | Count | Share |
|---|---:|---:|
| Done | 42 | 82% |
| Partial | 9 | 18% |
| Not started | 0 | 0% |

| Module | Owner | Done / Partial |
|---|---|---|
| Core — video analysis and keyframes | O | 10 / 5 |
| A — memory capture and scene input | O | 3 / 2 |
| C — face recognition | O | 3 / 0 |
| 7 — memory search | O | 3 / 0 |
| B — routine learning | T | 1 / 2 |
| D — location safety and emergency | T | 4 / 0 |
| 6 — activity summary | T | 4 / 0 |
| 8 — medication management | T | 3 / 0 |
| 9 — caregiver dashboard | T | 6 / 0 |
| 10 — user dashboard | T | 5 / 0 |

**"Partial" means the capability runs but something measurable is missing** — a
sub-feature, a validation, or a deployment step. It is not a synonym for
"nearly done". The audit names the specific gap and the file for each one.

---

## Slide 9 — Evidence: tested and integrated **[O]**

| Evidence | What it shows |
|---|---|
| 32 Python test suites, ~600 assertions | Belonging identification (9 suites, 172 assertions), privacy and retention (6 suites, 146), scene and sessions (4 suites, 83), conversation and faces (1 suite, 59), medication (4 suites, 69), pipeline and recovery (5 suites, 75) |
| 3 Flutter widget tests | Splash-to-login routing; memory screen refreshes only while visible; caregiver grid fits at 360 dp under 100% and 130% text scaling |
| Live measurement, not synthetic data | Several suites run against the wearer's real stored frames and skip when those have expired |
| Defects caught by tests, not by users | Two faults in the sensitive-room rule the first time it fired on real footage; 486 orphaned thumbnails surviving their frames; a refused frame consuming the capture cooldown so the first frame after privacy ended was dropped |

**Integration is proven end to end:** a dose detected by the Python pipeline
appears in the caregiver's feed on the dashboard and as a push notification on
the handset; an emergency raised on the handset reaches the caregiver's socket
room and their device; a call placed from the dashboard rings on the phone.

---

## Slide 10 — APIs, ML models and external services **[O]**

| Module | Model / service | Type | Why this one |
|---|---|---|---|
| Core, A | YOLO11n trained on Objects365 | Pre-trained | 365 classes rather than COCO's 80. It must name a kettle, a sofa, a toothbrush — the objects that identify a room and that a person owns |
| Core (medication) | Third-party pill detector, ONNX | Pre-trained, third-party | A generic object detector does not find a tablet. One class only: it locates a pill, it does not identify which medication — stated as a scope boundary |
| Core (medication) | MediaPipe Hands | Pre-trained | A pill visible in a frame is not a pill being taken. Landmarks establish the pill is within reach of a palm |
| Core (belongings) | MobileNetV3-Small, 576-D | Pre-trained | Cheap enough to embed every candidate region in every frame; used to shortlist |
| Core (belongings) | DINOv2 ViT-S/14 | Pre-trained | Self-supervised features separate two objects of the same class — this phone from that phone — which a classifier trained on class labels cannot |
| C | InsightFace buffalo_l | Pre-trained | Detection and 512-D recognition in one package, CPU-viable |
| A | faster-whisper, base, int8 | Pre-trained | Runs on CPU in real time at int8; only text is retained |
| 7 | LLM for answer phrasing | API, with fallback | Phrases an answer from retrieved records. A deterministic template answers if it is unavailable, and the phrasing step cannot invent a finding, a number or a link |

**No model was fine-tuned or self-trained.** Every model is pre-trained and
used as published. The work is in the decision logic around them: the
three-phase gesture sequence, the two-stage verification with its adjudicated
thresholds, the corroboration rules, and the confidence policy.

---

## Slide 11 — External services **[T]**

| Service | Used for | Why |
|---|---|---|
| Firebase Cloud Messaging | Reminders, findings, emergency escalation | The only reliable way to wake an Android app that is not in the foreground |
| SMTP (nodemailer) | The second delivery channel for every alert | Push fails silently when a device is off. Email is independent of it — both are attempted in parallel, not as a fallback chain |
| Google Maps JavaScript API | Caregiver location map | Already the platform's mapping provider on both clients |
| Google Maps URL handoff | Route home for the wearer; directions to the person for the caregiver | Hands off to an app that already does turn-by-turn well. Embedding the Navigation SDK would duplicate it |
| Google Sign-In | Optional account linking | Removes a password for a user who does not want to manage one |

**Not used, and worth stating:** no SMS gateway, no electronic health record
integration, no cloud storage provider, no emergency services integration. An
emergency reaches the wearer's own linked caregivers.

---

## Slide 12 — LLM usage disclosure **[Both]** · **FILL IN**

*State this plainly; the panel will ask follow-ups and vagueness reads worse
than the truth.*

**Where LLMs were used in development.** Claude Code was used as a coding
assistant throughout, under a written house style committed to the repository
(`.claudecode-instructions.md`), which constrains it: write as little code as
possible, no unrequested abstraction, prefer the standard library and existing
dependencies.

**Where an LLM runs in the product itself.** One place only — phrasing the
answer to a memory-search question and rewording a notification. It is
deliberately the last step and it is bounded: the message text is composed from
real counts by deterministic code first, and the phrasing step cannot introduce
a finding, a number or a link. A template answers if the model is unavailable.

**What we did ourselves — fill in per person:**

- Decided the detection rules and the thresholds, then measured them against real footage rather than accepting defaults
- Found and fixed the defects the assistant's code contained (name two or three specific ones)
- Wrote or specified the test suites that hold each rule
- Verified every integration on a real handset, not in an emulator
- *Add: which parts each of you designed before any code was written*

---

## Slide 13 — Individual contribution: Omair **[O]** · **FILL IN specifics**

**Owned: the Python inference service** — everything that happens to a frame.

| Area | What was built |
|---|---|
| Capture and pipeline | Stream reading at adaptive ≤5 fps, rolling frame buffer, per-event-kind capture cooldowns, plugin registry so a new detector touches one file |
| Medication detection | Three-phase sequence, weighted confidence blended with the weakest phase, evidence frame per phase, confidence policy at 0.85 / 0.70 |
| Belonging identification | Two-stage shortlist-then-verify, class agreement moving the threshold both ways, shape tie-breaking, one-item-one-place enforcement |
| Face recognition | Detection, 512-D embedding, matching against confirmed relationships, confirm-before-enrol |
| Scene and sessions | Room naming from a defining object with corroboration, room sessions, session evidence frames |
| Audio | 30-second in-memory ring buffer, transcription to text only, nothing written to disk |
| Privacy and retention | Whole-frame blurring, capture refusal, sensitive-room retroactive purge requiring corroboration, 36-hour sweeper across five stores |

**Measured, not assumed — give one of these as a worked example:**
- Phase 1's search window was bounded wrongly; widening it took a replayed
  session from no detection to 0.837 confidence
- The verifier threshold was set from the live score distribution: 0.557–0.725
  for true matches against 0.086–0.516 for refused ones
- 486 thumbnails were surviving the frames they came from; retention now
  deletes both

---

## Slide 14 — Individual contribution: Taqdees **[T]** · **FILL IN specifics**

**Owned: the Node application and both clients** — everything that happens to
an event once it exists.

| Area | What was built |
|---|---|
| API and authentication | 11 route modules in one Express application, JWT with role authorisation, caregiver linkage enforced server-side in three independent places |
| Notifications | FCM and SMTP as independent parallel channels, per-channel attempt counts and backoff at 1/5/15 minutes, abandonment after two hours, escalation of any unacknowledged alert after 15 minutes |
| Scheduling | A 60-second tick covering medication windows, reminder exhaustion and escalation, with a lease against self-overlap and a compare-and-set claim against a second process |
| Routine learning | 30-day baseline rebuilt daily, 24-slot weekday/weekend histograms, monitor every 30 seconds, six rules, per-rule deduplication keys enforced by a unique index |
| Emergency | Button and spoken trigger, socket alert to every caregiver before any text is composed, per-person caregiver emergency screen |
| Real-time and calls | Socket.IO with identity pinned at handshake and one room per user; WebRTC signalling gated on an existing caregiver link |
| Clients | Flutter application for both roles; React caregiver dashboard with feed, map, audit and storage report |

**Measured, not assumed — give one of these as a worked example:**
- The socket connection authenticated as a different user than the HTTP
  session; identity is now pinned at handshake for the connection's lifetime
- Chat messages were arriving twice; the optimistic message is now replaced by
  the server echo rather than appended to it
- The caregiver grid overflowed by exactly 10 px at 130% text scaling; a widget
  test now fails on any overflow at 360 dp

---

## Slide 15 — Remaining work **[Both]**

Stated specifically, because a named gap is defensible and a vague one is not.

| Gap | Owner | What it needs |
|---|---|---|
| Routine deviation alerts do not fire in practice | T | No signal in the collected baseline reaches the confidence floor. It needs more days of data, not more code |
| No transport encryption | T | Traffic is plain HTTP on the LAN. Terminating TLS is the single largest security item |
| No encryption at rest | T | Mitigated by the 36-hour expiry and authenticated frame access, not solved |
| Notification channels are indistinguishable | T | All pushes land on the fallback Android channel, so an emergency looks like a check-in |
| No persistent application error log | T | Delivery failures are durable; other errors reach the console only |
| Outdoor paths unexercised | O | Deliberately out of scope for tracking, but the item-loss radius rule has not been run outdoors |
| No formal face-recognition evaluation | O | The threshold is set from observed scores; no labelled accuracy figure exists |
| Not deployed | Both | No container, orchestration or host configuration. The service boundary exists; the deployment does not |

---

## Slide 16 — Live demonstration plan **[Both]**

Order chosen so each step uses the previous one's output.

1. **[O]** Start the stream; show the pipeline reading frames and naming the room
2. **[O]** Hold a pill, take it — show the three phases and the evidence frames
3. **[T]** The dose appears in the caregiver's feed and as a push on the handset
4. **[O]** Put down an enrolled belonging, walk away — the wearer is told which room
5. **[T]** Raise an emergency on the handset — caregiver alert, location, then a call
6. **[O]** Turn on privacy mode; show the refusal logged and no file written
7. **[T]** Memory search: ask where something was left, and get the frame back

**If the stream drops mid-demo**, say so and let it recover — the monitor
restarts the pipeline within three seconds, and that is itself a feature worth
showing.

---

## Slide 17 — Questions we expect **[Both]**

| Question | Answer |
|---|---|
| Is this microservices? | No. Two services on one machine, split by runtime. We considered microservices and rejected them: independent deployment and scaling are their benefits, and neither applies here |
| Why no inference on the phone? | The models do not fit and would exhaust the battery. The cost is that detection needs the backend reachable, and we state that |
| Did you train any models? | No. All pre-trained and used as published. The contribution is the decision logic around them |
| How do you know the medication detection works? | Four test suites, 69 assertions, including a differential check proving the previous search bound found nothing. Evidence frames are kept for every recorded dose |
| What about privacy? | Local inference, 36-hour deletion, no audio on disk, whole-frame blurring under the wearer's control, and a sensitive-room purge that needs corroboration before destroying anything |
| Is it secure? | Access control is strong and enforced server-side in three places. Transport encryption is absent and is our largest known gap |
