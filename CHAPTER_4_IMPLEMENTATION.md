# Chapter 4: Implementation

This chapter describes the components of LOCUS that are built and running. Every
figure, threshold, version and file path below was taken from the repository
rather than from design intent; where a measurement is quoted, it was produced
by running the system on the wearer's own recordings.

**Scope.** The implemented system covers the Core Module (Real-Time Video
Analysis and Keyframe Extraction), Supporting Module A (Memory Capture and
Scene Input), Supporting Module C (Face Recognition), Supporting Module D
(Location Safety and Emergency Response), and Modules 6 through 10 (Activity
Summary, Memory Search, Medication Management, Caregiver Dashboard and User
Dashboard). Supporting Module B (Routine Learning) builds per-user profiles but
does not yet assert expectations from them, and is therefore excluded from this
chapter. Also excluded are the outdoor item-tracking paths, which exist in code
but have never been exercised against outdoor footage.

---

## 4.1 Project Methodology and Algorithms

### 4.1.1 Implementation Pipeline

**Step 1 — Capture.**
The wearer's camera is a GoPro on a chest mount. It publishes an RTMP stream to
a local MediaMTX server, which republishes it as RTSP at
`rtsp://<host>:8554/live/<user_id>`; the per-user path is what allows one
machine to serve several wearers. The `VideoSource` class consumes that stream
through OpenCV's FFMPEG backend, and accepts a local webcam index or an MP4 file
in its place, so the pipeline can be run and tested without camera hardware. A
background `StreamMonitor` polls every three seconds and starts or stops a
per-user pipeline as the stream appears and disappears.

Frames arrive at 1280×720. Model weights are loaded lazily rather than at
startup — the DINOv2 verifier is 88 MB and most frames never produce a candidate
that needs it.

**Step 2 — Preprocessing and adaptive capture rate.**
A motion score is computed by frame differencing in OpenCV: successive frames are
converted to greyscale, their absolute difference is summed and normalised by
frame area. `CAPTURE_FPS` (5.0) is a ceiling rather than a rate;
`KeyframeExtractor.should_capture()` reduces below it when the scene is still, so
analysis is spent on frames that contain something. Measured heartbeats on the
live system report 4 to 6 captured frames per second during activity.

For the pill detector, frames are letterboxed to 640×640, converted to CHW order
and normalised to float32 in [0, 1]. ONNX Runtime is restricted to
`os.cpu_count() - 1` intra-op threads: the medication batch and the item indexer
share one machine, and measured against the all-core default the indexer's tile
scan fell from 24.6 s back to between 1.7 s and 7.0 s.

**Step 3 — Per-frame feature extraction.**
Three detectors run over a frame, each for a different question:

- **Pill detection** — an ONNX single-class detector at 640×640, producing boxes
  and confidences.
- **Hand landmarks** — MediaPipe Hands, giving 21 3-D landmarks per hand, from
  which palm area, grip and wrist height are derived.
- **Object and scene detection** — YOLO11n trained on Objects365 (365 classes),
  which supplies both the candidate boxes for belongings and the object
  vocabulary the room classifier reasons over.

Derived geometry includes hand–pill overlap, the pill box's area as a fraction of
the frame, and its aspect ratio. Frames containing neither a pill nor a hand are
discarded before they reach the temporal buffer.

**Step 4 — Temporal sequence modelling.**
No intake is decided from one frame. The extractor keeps a rolling buffer of
`BUFFER_SECONDS` (30 s) and each analysis pass examines 60 frames from it,
searching for three phases **in order**:

- **Phase 1** — a pill confirmed *in* a hand: the box overlaps the palm region,
  clears `PHASE2_MIN_PILL_CONF` (0.45), and passes fingertip and palm checks.
- **Phase 2** — that hand rising toward the mouth, scored from upward motion,
  hand height and near-top position. The pill's continued visibility *adjusts*
  this score by ±0.10 but cannot veto the sequence: fingers close around a 13 mm
  tablet as the hand rises, and requiring the detector to see through a fist
  rejected every genuine dose.
- **Phase 3** — the hand returning empty, scored on the drop in pill confidence.

Phase 1 may be found anywhere there is room for the two phases that must follow,
which is the condition the search loop already enforces. An earlier bound
reserved 30% of the buffer and discarded a real dose whose only pill-in-hand
frames were 48, 49 and 50 of 60.

**Step 5 — Confidence and classification.**
Scores are combined so that no single weak phase can hide behind a strong
average:

```
weighted_avg = p1 * 0.35 + p2 * 0.30 + p3 * 0.35
confidence   = weighted_avg * 0.80 + min(p1, p3) * 0.20
```

`ConfidencePolicy` then classifies: **≥ 0.85** auto-verified, **≥ 0.70** needs
confirmation, below that discarded. A sequence in which all three phases passed
is never classified as missed — it is floored at *needs confirmation*, because
asking the wearer is the honest response to a complete observation scored low.

**Step 6 — Scheduling and persistence.**
A multi-user scheduler polls every 60 seconds. Each scheduled dose opens a
**120-minute verification window**; if the window closes without a confirmed
intake, the dose is recorded as missed and the caregiver is notified. Evidence
frames are written to per-user, per-date directories under five separate stores
(`keyframe_storage`, `items_storage`, `activities_storage`, `social_storage`,
`medications_storage`), each swept on a 36-hour TTL.

**Step 7 — Deployment as it currently stands.**
The AI backend is FastAPI (Uvicorn) on port 8000, running as a standalone
service on a desktop machine — it is *not* embedded in the mobile app. The
application backend is Node.js/Express on port 5000 with MongoDB, and the React
dashboard is served by Vite. The Flutter app discovers the backend's address on
the local network rather than having it hardcoded. All three currently run on one
machine against a local `mongod`; hosting is a deployment step that has not been
taken.

---

### 4.1.2 Algorithms

#### Algorithm 4.1 — Adaptive keyframe capture with motion gating

```
procedure ShouldCapture(frame, prev_frame, now)
    gray_curr  <- greyscale(frame)
    gray_prev  <- greyscale(prev_frame)
    motion     <- sum(abs_diff(gray_curr, gray_prev)) / (width * height)
    interval   <- 1 / CAPTURE_FPS                  // 5 fps ceiling
    if motion < SCENE_MOTION_THRESHOLD then
        interval <- interval * QUIET_FACTOR        // fewer frames when still
    end if
    if now - last_capture < interval then return false end if
    buffer.append(frame)                           // bounded by BUFFER_SECONDS
    return true
end procedure
```

#### Algorithm 4.2 — Three-phase medication intake detection

```
procedure AnalyseKeyframesBatch(analysed[0..n-1])
    if no frame has best_pill >= 0.45 then return []          // nothing to find
    results <- []
    search_start <- 0
    while search_start < n - 2 do
        // Phase 1: strongest pill-in-hand frame, anywhere there is room after it
        p1 <- argmax over i in [search_start, n-2] of best_pill(i)
              subject to pill_in_hand(i) and hands(i) > 0 and best_pill(i) >= 0.45
        if p1 not found then break end if

        // Phase 2: best hand-toward-mouth frame after p1
        p2 <- argmax over i > p1 of composite(height, motion, near_top)
        if p2 not found then search_start <- p1 + 1; continue end if
        p2_score <- max(motion, near_top) + height_bonus
        if best_pill(p2) >= 0.45 then p2_score <- p2_score + 0.10
        else p2_score <- p2_score - 0.10                       // occluded, not absent
        end if

        // Phase 3: best hand-visible, pill-absent frame after p2
        p3 <- argmax over i > p2 of (emptiness, hand_visibility, returned)
        if p3 not found then search_start <- p2 + 1; continue end if
        if not (p1 < p2 < p3) or timestamps out of order then
            search_start <- p1 + 1; continue
        end if

        p1_score <- best_pill(p1) + 0.05 if in_hand_count >= 1
        p3_score <- clamp(pill_drop / best_pill(p1), 0.70, 1.0)
        weighted <- p1_score*0.35 + p2_score*0.30 + p3_score*0.35
        confidence <- weighted*0.80 + min(p1_score, p3_score)*0.20

        classification <- AUTO_VERIFIED      if confidence >= 0.85
                          NEEDS_CONFIRMATION if confidence >= 0.70
                          MISSED             otherwise
        if all three phases passed and classification = MISSED then
            classification <- NEEDS_CONFIRMATION     // never discard a full observation
        end if
        results.append(event with phase frames and confidence)
        search_start <- p3 + 1
    end while
    return results
end procedure
```

#### Algorithm 4.3 — Belonging identification by two-stage verification

This is the mechanism by which a detected object becomes *this wearer's phone*
rather than *a phone*.

```
procedure IdentifyBelonging(box, crop, enrolled_items)
    best <- none; second <- none
    for item in enrolled_items do
        strict <- class_agreement_threshold(box, item)   // 0.65 agree, 0.85 disagree
        if confidence(box) < candidate_floor then
            strict <- max(strict, 0.75)                  // faint boxes prove more
        end if
        bar <- strict
        if class_agrees(box, item) and verifier_available() then
            bar <- min(strict, 0.55)        // MobileNet shortlists, DINOv2 decides
        end if
        sim <- max cosine(crop_embedding, item.gallery)  // MobileNetV3, 576-D
        if sim >= bar then record as best/second by sim end if
    end for
    if best and second and (best.sim - second.sim) < AMBIGUOUS_MARGIN then
        resolve by box aspect ratio if the two shapes are separable,
        otherwise claim neither              // a coin toss is not an identification
    end if
    if best then
        (ok, why, score) <- verifier_agrees(crop, best.verify_gallery)   // DINOv2, 384-D
        if not ok then reject end if
        if why != "agreed" and best.sim < strict then reject end if
            // a relaxed bar is only licensed by a check that actually ran
        return best
    end if
end procedure
```

#### Algorithm 4.4 — Evidence retention with TTL

```
procedure CleanupExpired(store, ttl_hours = 36)      // every 30 minutes, per store
    expired <- []
    for sidecar in store/*/*/*.json do
        if saved_at(sidecar) < now - ttl_hours then expired.append(id) end if
    end for
    retained <- ids referenced by a FLAGGED event, medication log,
                relationship portrait or enrolled-item portrait
    for id in expired and not in retained do
        delete id.jpg, id.json and every cached thumbnail of id
    end for
    remove empty date directories
end procedure
```

#### Algorithm 4.5 — Medication scheduling with missed-dose backfill

```
procedure SchedulerLoop()                              // every 60 seconds
    for each user with active medications do
        for each scheduled time due now do
            open a 120-minute verification window
            if the wearer is streaming then start/refresh their pipeline
            else record the session; it starts when the camera does
        end for
        for each window whose deadline has passed do
            if no confirmed intake was logged then
                mark the dose missed (or camera_off if nothing was recorded)
                notify caregivers, once, guarded by caregiver_notified
            end if
        end for
    end for
end procedure
```

---

## 4.2 Model Selection and Evaluation

### 4.2.1 No model was trained for the deployed system

This is stated plainly because it determines how the system should be judged.
Every model LOCUS runs is pretrained or third-party:

| Model | Role | Provenance |
|---|---|---|
| Pill detector (`best_model.onnx`) | pill/capsule boxes | third-party, `github.com/seblful/pills-detection` |
| YOLO11n-Objects365 | object boxes, scene vocabulary | pretrained, 365 classes |
| MediaPipe Hands | 21 3-D hand landmarks | off-the-shelf |
| MobileNetV3-Small | 576-D appearance embedding | pretrained (ImageNet) |
| DINOv2 ViT-S/14 | 384-D instance embedding | pretrained (`timm`) |
| InsightFace buffalo_l | face detection and 512-D recognition | pretrained |

A Kaggle fine-tuning workflow for YOLO11n on a custom egocentric belongings
dataset (60 epochs, 640 px) exists at
`detection_pipeline/scripts/kaggle_train_yolo11_personal_items.py`, but its
output is not the model the running system loads.

**The engineering contribution is therefore not training — it is the decision
logic around pretrained models, and the calibration of that logic against the
wearer's own footage.** That is what the following measurements evaluate.

### 4.2.2 Identification accuracy on the wearer's recordings

**Two-stage verification.** MobileNetV3 shortlists and DINOv2 decides. Measured
on this account's stored frames, the verifier separates genuine sightings from
refusals, but by a narrow margin on camera-quality crops:

| | Range |
|---|---|
| Genuine phone sightings (10, one morning) | 0.557 – 0.725 |
| Refused boxes of an enrolled class (16) | 0.086 – 0.516 |
| Operating threshold | 0.55 |

The worst true sighting clears the bar by 0.007. The same model scores 0.961 on
a held-out *enrolment-quality* crop, which is why that figure is recorded in the
code as unrepresentative of live frames and not used as headroom.

**Shortlisting bar.** Lowering the detector-box bar to 0.55 where the verifier
can adjudicate raised recall on a labelled set of real crops from **48% to 88%
with no new false positives**.

**Gallery enrichment.** Adding camera-space exemplars to enrolment galleries,
admitted only where the verifier agreed, moved a sample of real crops from
**52 confirmed / 35 refused** to **77 confirmed / 10 refused**, with knife-edge
cases falling from 17 to 3 and no decoy admitted.

**Ambiguity refusal.** Two belongings scored 0.770 and 0.763 against the same
box — seven thousandths apart. The system claims neither unless box aspect ratio
separates them, on the reasoning that a missed sighting is a gap in the record
while a confident wrong one sends somebody to the wrong room.

### 4.2.3 Room classification

Evaluated over all 86 stored frames:

| Outcome | Count | Share |
|---|---|---|
| No defining object in view (correct refusal) | 60 | 71% |
| Defining object below its confidence floor | 21 | 25% |
| Cleared the floor, too few corroborating objects | 1 | 1% |
| Room named | 3 | 4% |

A room is named only when one of its defining objects (bed, fridge, couch,
toilet, dining table) is seen clearly enough, then confirmed by the room's other
objects, a score floor and a margin over the runner-up. Rooms the wearer asked to
be treated as sensitive are held to 0.80 rather than 0.55, because recognising
them causes frames to be destroyed.

### 4.2.4 Medication detection

Validated by replaying 60 recorded frames of a real dose through the detection
loop: the sequence resolves to Phase 1 at frame 49, Phase 2 at 51, Phase 3 at 54,
**confidence 0.837** — needs confirmation, with its three evidence frames. The
same frames under the earlier search bound produced no sequence at all, which is
the regression that replay now guards against.

---

## 4.3 Security

Stated as implemented, not as intended. Items that are deployment steps rather
than code are marked as such.

| Mechanism | Technology | Implementation |
|---|---|---|
| Token authentication | `jsonwebtoken` 9.0.2 | Every protected route requires a bearer JWT. Tokens are signed `{ sub, role }` with `JWT_SECRET` and expire after **7 days** (`JWT_EXPIRES_IN=7d`). Password-reset links use a separate 15-minute token. No refresh-token mechanism is implemented. |
| Password hashing | `bcryptjs` 2.4.3 | Hashed with **10 rounds** in a Mongoose pre-save hook; plaintext is never stored or logged. |
| Socket authentication | `socket.io` 4.8.3 | The WebSocket handshake carries the same JWT; the server verifies it and attaches the user, then joins a room named by their user id. Call signalling is relayed only between users with an established caregiver link. |
| Role-based access | Custom middleware | Three roles: `user`, `elderly`, `caregiver`. Caregiver access is scoped to accounts that have accepted a link; keyframe queries are filtered server-side to the caller's own id plus the accounts they monitor, so a client asking for another user's frames receives none. |
| Per-user storage isolation | File system layout | Evidence is written to `<store>/<user_id>/<date>/<id>.jpg`; ids are UUIDs and paths are constructed, never taken from request input. |
| Retention | TTL sweeper | All five stores are swept every 30 minutes on a 36-hour TTL, with flagged evidence retained. Cached thumbnails are deleted with their frame. |
| Privacy control | `ai/privacy.py` | A wearer-controlled Privacy Mode stops frames being written at all, and a blur mode writes them unreadable. The check runs before a frame is captured, and governs the microphone as well as the camera. Rooms the wearer marks sensitive trigger the same refusal automatically. |
| Secret handling | `.gitignore` | `.env` files and `firebase-service-account.json` are excluded from version control. Client API keys that necessarily ship in the app bundle are restricted by package name and SHA-1 fingerprint, and scoped to the two APIs the app uses. |

**Not implemented, and stated as such.** Transport is plain HTTP on the local
network; TLS is a hosting step. The database is a local `mongod` without
encryption at rest. `express-validator` is listed as a dependency but is not
used by any route. CORS is currently open (`app.use(cors())`) rather than
restricted to known origins.

---

## 4.4 External APIs, SDKs and Libraries

Versions are those installed and running.

| Component | Version | Role |
|---|---|---|
| FastAPI | 0.136.1 | AI backend HTTP service |
| ONNX Runtime | 1.24.2 | Pill detector inference, CPU |
| Ultralytics | 8.4.14 | YOLO11n object and scene detection |
| MediaPipe | 0.10.14 | 21-point hand landmarks |
| OpenCV | 4.13.0 | Capture, motion scoring, preprocessing, blur |
| PyTorch | 2.10.0 | Backbone runtime for the embedding models |
| timm | 1.0.29 | DINOv2 ViT-S/14 verifier |
| InsightFace | 1.0.1 | Face detection and recognition (buffalo_l) |
| faster-whisper | 1.2.1 | On-device speech transcription |
| PyMongo | 4.7.2 | Event and metadata writes from the AI backend |
| Express | 4.19.2 | Application REST API |
| Mongoose | 8.4.0 | Schema validation and querying |
| Socket.IO | 4.8.3 | Live alerts, chat and call signalling |
| jsonwebtoken | 9.0.2 | Token issue and verification |
| bcryptjs | 2.4.3 | Password hashing |
| node-cron | 3.0.3 | Notification scheduling and retry sweeps |
| firebase-admin | 14.1.0 | FCM push delivery |
| Nodemailer | 6.9.13 | Email escalation |
| React | 19.2.0 | Caregiver and user dashboards |
| Flutter / Dart | 3.35.3 / 3.9.2 | Mobile application |
| MediaMTX | — | RTMP ingest, RTSP republish, per-user stream paths |
| Google Maps (Android SDK, JS API) | — | Maps in the app and dashboard; navigation home is handed to the Maps app |
```
