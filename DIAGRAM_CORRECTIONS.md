# Architecture Diagram Corrections

Two prompts, one per diagram. Each is self-contained: paste it with the diagram
into whatever tool produced it.

Every correction below was checked against the repository. Items marked **ADD**
exist in the system and are missing from the diagram; items marked **DELETE**
appear in the diagram and do not exist in the system.

---

## Prompt 1 — System architecture (the seven-layer diagram)

```
Update this LOCUS architecture diagram. Keep the same visual style, colour
coding, layer numbering and overall layout. Apply all of the following
corrections, which align it with the system as actually built.

LAYER 1 — DATA CAPTURE
• CHANGE "Wearable Sensors — Heart rate, activity, sleep, steps" to
  "Motion Sensors — Step counting, fall detection". There is no heart-rate
  monitoring and no sleep tracking anywhere in the system.
• ADD "Stream Server (MediaMTX) — Camera publishes RTMP, republished as RTSP
  on a per-user path". This is how video reaches the backend and is missing.
• ADD "Item Enrolment — The wearer photographs a belonging to create its
  reference gallery". Nothing can be identified without this step.

LAYER 2 — CLIENT APPLICATION (FLUTTER)
• ADD "Caregiver Screens — Family list, per-person emergency screen,
  keyframe audit, activity feed".
• ADD "Chat — Text messaging between wearer and caregiver".
• CHANGE "Offline Mode — Local storage & sync when online" to
  "Local Session Cache — Token and preferences". There is an endpoint that
  returns frames for local saving, but no general offline queue.

LAYER 3 — CORE INTELLIGENCE
• CHANGE "Privacy & Security — Face blurring, data protection, consent" to
  "Privacy & Security — Whole-frame blurring, capture refusal, consent".
  Blurring applies to the entire frame, not to detected faces.
• CHANGE "Event Detection Engine — Detects daily activities, falls,
  anomalies" to "Event Detection Engine — Room sessions, belongings,
  deviations".
• ADD "Belonging Identification — Two-stage verification against the
  wearer's enrolled galleries". This is one of the largest subsystems and
  does not appear anywhere on the diagram.
• ADD "Face Recognition — Matches a face to the relationship record;
  unknown faces are never enrolled automatically".
• ADD "Scene Classification — Names a room only from a defining object,
  corroborated".
• ADD "Retention Sweeper — Deletes evidence after 36 hours unless flagged".
• ADD "Schedulers — One cron tick each minute (medication windows,
  escalation, notification retry), routine monitor every 30 s, routine
  profiles rebuilt daily, nightly batch at 02:00, retention every 30 min".

LAYER 4 — AI / ML PROCESSING
• REPLACE "TFLite Inference — On-device AI inference" with
  "ONNX Runtime + PyTorch — Inference on the backend machine". There is no
  TensorFlow Lite in this project, and no inference runs on the handset.
• CHANGE "Object Detection — Detect objects & interactions" to
  "Object Detection (YOLO11n / Objects365, 365 classes)".
• CHANGE "Activity Recognition — Recognize daily activities" to
  "Room Session Tracking — Groups scene classifications into visits".
• CHANGE "Speech-to-Text — Convert speech to text" to
  "Speech-to-Text (faster-whisper on the backend; platform recognition in
  the app)".
• ADD "Pill Detection (ONNX, single class, 640x640)".
• ADD "Hand Landmarks (MediaPipe Hands, 21 points)".
• ADD "Appearance Embedding (MobileNetV3-Small, 576-D)".
• ADD "Instance Verifier (DINOv2 ViT-S/14, 384-D)".
• ADD "Face Embedding (InsightFace buffalo_l, 512-D)".

LAYER 5 — BACKEND
• RETITLE the layer from "CLOUD & BACKEND LAYER" to "BACKEND LAYER".
  Nothing is hosted; all services run on one machine.
• CHANGE "MongoDB Atlas — Primary database" to
  "MongoDB (local instance) — Primary database".
• REPLACE "AWS S3 Storage — Store keyframes, audio, documents" with
  "Local Evidence Stores — Five on-disk stores by user and date, 36-hour
  retention". There is no AWS SDK in the project, and audio is never
  written to disk at all.
• ADD "Python AI Service (FastAPI) — The detection pipeline, separate from
  the Node.js application".

LAYER 6 — EXTERNAL SERVICES
• DELETE "SMS Gateway". No SMS is ever sent; the delivery record carries an
  unused sms placeholder field only.
• DELETE "Third-Party Health APIs (optional)". None exist.
• CHANGE "Emergency Services — SOS, emergency response" to
  "Caregiver Escalation — Push and email, with automatic retry". The SOS
  reaches linked caregivers; there is no integration with emergency
  services.
• ADD "Google Sign-In — Optional account linking".
• KEEP "Email Service" and "Maps / GPS API"; both are accurate.

LAYER 7 — OUTPUT & INTERACTION
• ADD "Voice Calls — Peer-to-peer audio between wearer and caregiver".
• ADD "Keyframe Audit — Caregiver reviews and flags stored frames".
• ADD "Belongings View — Where each item was last seen".
• ADD "Relationship Management — Confirm or dismiss an unknown face".
• ADD "Storage Usage — What is being kept, and for how long".

Everything not listed above is accurate and should be left unchanged.
```

---

## Prompt 2 — Layered / microservices diagram

```
Update this LOCUS architecture diagram. Keep the visual style, the numbered
tiers and the colour coding. This diagram has one structural error and many
detail errors; correct all of them.

STRUCTURAL — THE LARGEST CHANGE
• The backend is NOT microservices. It is one Node.js/Express application
  mounting route modules, plus one separate Python FastAPI service.
  Replace the "MICROSERVICES BACKEND ARCHITECTURE" panel with
  "BACKEND ARCHITECTURE — Two services":
    - a single "Node.js / Express Application" box, with its route modules
      drawn INSIDE it rather than as independently deployable services:
      auth, medications, caregiver, notifications, detection, event-logs,
      relationships, user-items, location, users, storage;
    - a single "Python FastAPI AI Service" box containing: detection
      pipeline, item indexer, scene classifier, face recognition,
      transcriber, keyframe storage and the retention sweeper.
• DELETE the "COMMUNICATION BUS (RabbitMQ / Redis / NATS)" band. None of
  these exist. The Node application calls the Python service over HTTP, and
  both push to clients over Socket.IO.
• In "ARCHITECTURE OVERVIEW", replace the "Microservices Backend" bullet
  with "Two services — one Node.js application and one Python AI service,
  run side by side on one machine."
• RENAME every "... SERVICE" box to "... Module".

TIER 1 — DEVICE / HARDWARE
• CHANGE "Wearable Camera (1080p@30fps)" to
  "Wearable Camera (1280x720, adaptive up to 5 fps)".
• CHANGE "Wi-Fi Direct" to "Wi-Fi — RTMP to a local MediaMTX server".
• DELETE "BLE 5.0". No Bluetooth is used anywhere.
• ADD "MediaMTX — RTMP ingest, RTSP republish per user" as the link between
  this tier and the AI service.

TIER 2 — MOBILE CLIENT
• RETITLE "MOBILE EDGE (SMARTPHONE) LAYER — On-Device Processing" to
  "MOBILE CLIENT LAYER". No AI inference happens on the phone.
• DELETE "OpenCV 4.9 (Keyframe Extraction)" — OpenCV 4.13 runs on the
  backend machine, not the handset.
• DELETE "TensorFlow Lite 2.15 (On-device Inference)" — no TFLite exists.
• CHANGE "Sensors: GPS, Accelerometer, Mic, Motion" to
  "Sensors: GPS, microphone, step counter".
• ADD "Speech recognition for memory search and the spoken SOS phrase".
• ADD "WebRTC audio for caregiver calls".

NEW TIER — AI BACKEND (insert between tiers 2 and 3)
• ADD a tier "AI BACKEND (desktop) — Python 3.11, FastAPI, Uvicorn"
  containing: ONNX Runtime (pill detector), YOLO11n/Objects365 (objects and
  scene), MediaPipe Hands, MobileNetV3-Small and DINOv2 (belonging
  identification), InsightFace buffalo_l (faces), faster-whisper
  (transcription), and the five evidence stores with their 36-hour sweeper.

TIER 3 — API LAYER
• RETITLE "CLOUD API LAYER" to "API LAYER".
• CHANGE "Node.js 20.x" to "Node.js 22.x".
• CHANGE both arrows labelled "HTTPS (TLS 1.3)" to
  "HTTP on the local network (TLS not yet configured)".
• DELETE "Rate Limiting". None is implemented.
• ADD "Socket.IO — JWT-authenticated, one room per user; carries alerts,
  chat and call signalling".
• ADD "Background loops — one cron tick every 60 s (medication windows,
  escalation, notification retry), routine monitor 30 s, routine learner
  24 h, nightly batch at 02:00, stream monitor 3 s".

TIER 4 — DATA & MEDIA
• CHANGE "MongoDB 8.0 (Mongoose ODM)" to
  "MongoDB (local instance), Mongoose 8.4".
• DELETE "MongoDB Change Streams (Real-time Sync)". Not used; real-time
  updates go over Socket.IO.
• DELETE "AWS S3 (Media Storage — Keyframes, Audio)" and
  "Pre-signed URLs for Secure Access". Replace with "Local evidence stores
  — keyframes, items, activities, social, medication evidence; per user and
  date; 36-hour retention". Audio is never stored.
• ADD "Collections: users, eventlogs, medications, medication_logs,
  relationships, useritems, locationlogs, notifications, messages,
  transcripts, routine_profiles, routine_findings, keyframemetas,
  stepcounts".

TIER 5 — CLIENT LAYER
• KEEP as drawn. ADD "Keyframe audit, belongings view, relationship
  management, storage usage" to the caregiver dashboard items.

MODULE BOXES
• NOTIFICATION: DELETE "Twilio (SMS/Call)". Keep FCM and SMTP. ADD
  "Delivery retry sweep".
• LOCATION & SAFETY: CHANGE "Geofencing" to "Home-radius check (150 m)".
  ADD "Spoken and button SOS; per-person caregiver emergency screen".
• VIDEO & ACTIVITY: ADD "Belonging identification" and "Privacy-mode
  capture refusal".
• MEMORY SEARCH: ADD "LLM answer with deterministic template fallback".
• MEDICATION: ADD "Evidence frames per phase" and "Rewatch a missed slot".
• CAREGIVER DASHBOARD: ADD "Chat" and "Voice call".

DATA STORES PANEL
• KEEP MongoDB. DELETE the "MongoDB Change Streams" and "AWS S3" icons.
• ADD a "Local evidence stores" icon.

RESILIENCE & FAULT TOLERANCE PANEL
• RETITLE to "PLANNED: RESILIENCE & FAULT TOLERANCE", or remove it. The
  behaviour it describes does not exist yet.
• "TFLite Models Run Locally" is false. All inference happens on the AI
  backend; if it is unavailable, detection stops entirely.
• "Data Cached & Synced When Online" overstates what exists.
• ACCURATE as drawn: the camera stream is monitored every three seconds and
  a pipeline restarts by itself when the stream returns, and a medication
  session that opens while the camera is off is held until it comes back.
  Keep those two if the panel is retained.

EXTERNAL SERVICES
• KEEP Google Maps API. DELETE "Third-Party Health APIs".
• ADD "Firebase Cloud Messaging" and "SMTP email".
```

---

## The two corrections that matter most

**The microservices claim.** "Each capability is a standalone service that can
be deployed, scaled and updated independently" is a specific architectural
assertion, and `web_app/backend/server.js` mounts eleven route files into one
Express application. Everything else on that diagram is a detail; this is a
different architecture from the one that was built.

**AWS S3 and MongoDB Atlas appear on both diagrams.** There is no AWS SDK in
`package.json`, and the connection string is `mongodb://127.0.0.1:27017`.
