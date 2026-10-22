# LOCUS System Architecture — Narrative

The prose description of the layered architecture, corrected against the
implemented system. Companion to DIAGRAM_CORRECTIONS.md.

---

## Overview

LOCUS is built as a layered, locally deployed system that provides continuous
cognitive support around a wearable camera. Its operational pipeline runs
Wearable Camera → Stream Server → AI Backend → Application API → Clients: the
camera publishes its stream over Wi-Fi to a stream server on the premises, an
inference service reads that stream and derives events from it, and an
application API records those events and serves them to the mobile application
and the caregiver dashboard. The smartphone is the user's interaction device and
the source of the signals only it can provide — location, step count, fall
detection and speech — rather than a relay for video or a site of analysis. All
model inference is performed by one backend service on a machine on the same
network, which makes the deployment a single-premises one rather than a
cloud-hosted or distributed deployment, and makes that machine's availability a
stated precondition for new detection.

## Architectural style

The system stack for LOCUS uses a Layered (N-Tier) architectural style
throughout, with the back end divided into two services along a runtime
boundary rather than along feature lines. This arrangement was selected for
three main reasons. First, the wearable, smartphone and backend data flow is
strongly hierarchical: the camera publishes to a stream server, the stream
server is read by the inference service, the inference service writes events
through the application API, and the API serves the clients, each tier
interacting only with those immediately around it. Second, the system's
intelligence is written in Python and its application logic in Node.js, so the
division between a FastAPI inference service and an Express API is a real
boundary imposed by the model ecosystem rather than an organisational
preference; within each service, capabilities such as video processing, memory
search, medication management, location safety and caregiver dashboarding are
modules of one deployable unit, which keeps a shared database and a shared
authentication path simple at this scale. Third, the partition still yields
useful behaviour under partial failure: because escalation, reminders,
messaging and access to everything already recorded live in the application
API, an emergency alert still reaches a caregiver and a medication reminder
still fires when the inference service is unavailable, and what stops is only
the analysis of new frames. The camera stream is additionally monitored every
three seconds so that a pipeline resumes by itself when the stream returns,
and a medication window that opens while the camera is off is held rather than
recorded as a missed dose.

A microservices style was considered and not adopted. Independent deployment
and independent scaling are its principal benefits, and neither applies to a
system whose services run on one machine against one database, while its costs
— inter-service transport, distributed transactions, duplicated
authentication — would be paid in full. The module boundaries drawn here are
the ones a microservices decomposition would follow if the system were later
deployed at a scale that justified it.

---

The LOCUS system is built on a layered architecture that supports memory
assistance, medication adherence monitoring, belonging tracking, behavioural
analysis and real-time activity reporting through a wearable camera, a mobile
application, a local AI backend and caregiver connectivity. The architecture
serves both elderly users and normal users, where a normal user can monitor and
manage their own day independently through the wearable ecosystem, while an
elderly user additionally benefits from caregiver linkage, routine deviation
monitoring and emergency escalation to the caregivers linked to their account.

The Data Capture Layer consists of the sensing components that collect
contextual information from the user's environment. A chest-mounted wearable
camera captures the visual record of the day: it publishes an RTMP stream to a
MediaMTX server on the local network, which republishes it as RTSP on a path
unique to the user, and the AI backend reads frames from that path at 1280x720
and up to five frames per second, adapting the rate to the processing load. The
smartphone's microphone captures speech, both for spoken commands handled by the
platform's own speech recogniser and for conversation audio transcribed on the
backend. GPS services on the handset record location, and the handset's motion
sensors provide step counting and fall detection. Medication input services
allow schedules, reminders and confirmation tracking to be entered by the user
or a caregiver, and an item enrolment service lets the user photograph a
belonging to create the reference gallery against which that object is later
recognised.

The Client Application Layer is implemented in the Flutter framework and
currently built and tested on Android. The mobile application is the primary
interaction interface for both elderly and normal users. For the wearer it
provides a dashboard, reminders, memory search, a belongings view and an
emergency button that can also be raised by speaking a recognised phrase. For
the caregiver it provides a list of the people they are linked to, a separate
emergency screen for each of them, a per-person activity feed, a keyframe audit
view, relationship management and a storage usage report. Both roles can
exchange text messages and place peer-to-peer voice calls. The application
discovers the backend's address on the local network rather than relying on a
hardcoded endpoint, holds the session token and the user's preferences in local
storage, and receives live updates over a persistent socket connection.
Contextual processing is not performed on the handset; frames are analysed on the
AI backend and the application consumes the results.

The Core Intelligence Layer, referred to as the LOCUS Engine, is responsible for
cognitive assistance and behavioural monitoring, and runs as a Python service on
the backend machine. The Event Detection Engine derives room sessions, belonging
sightings and social interactions from the captured frames. The Medication
Monitoring module tracks adherence through a three-phase analysis of the frames
surrounding a scheduled dose, recording the evidence for each phase and
distinguishing a dose it can log automatically from one that requires caregiver
confirmation. The Belonging Identification module performs two-stage verification
of a detected object against the user's enrolled galleries, so that a possession
is recognised wherever it is set down. Face Recognition matches a face against
the user's relationship records and never enrols an unknown face without
confirmation. Scene Classification names a room only on the evidence of a
defining object, corroborated across frames. Behavioural Analysis builds a
routine profile from a thirty-day baseline, rebuilt daily, and a monitor
compares the current day against it every thirty seconds to raise deviation
findings; a home-radius check reports when the user is away from their
registered address. The Privacy module governs whole-frame blurring, refusal of
capture while privacy mode is active, and retroactive deletion of a stretch
recorded in a room the user has marked sensitive, which requires corroboration
from a second frame before anything is destroyed. A retention sweeper deletes
stored evidence after thirty-six hours unless a caregiver has flagged it. The
Notification Manager handles push and email delivery with an automatic retry
sweep, and the Authentication module enforces token-based, role-aware access
control over every route.

The AI and Machine Learning Processing Layer performs all inference on the
backend machine rather than on the handset. ONNX Runtime and PyTorch provide the
execution environment, with thread use bounded so that the machine remains
responsive. Object detection is performed by a YOLO11n model trained on the
Objects365 dataset, whose 365 classes supply both the candidate regions for
belonging identification and the vocabulary from which a room is named. A
separate single-class ONNX detector locates pills at 640x640. MediaPipe Hands
provides twenty-one three-dimensional landmarks per hand, which establish whether
a detected pill is actually within reach of a hand rather than merely present in
the frame. Belonging identification uses a MobileNetV3-Small embedding to
shortlist candidates and a DINOv2 Vision Transformer embedding to adjudicate
between them. Faces are embedded by the InsightFace buffalo_l model. Speech is
transcribed by faster-whisper over rolling windows of backend audio, while the
mobile application uses the platform's own recogniser for memory search and the
spoken emergency phrase. A confidence policy evaluates the reliability of every
derived event before it is recorded, logged automatically or escalated: a
sufficiently strong result is recorded without intervention, a weaker one is held
for caregiver confirmation, and a result below the floor is discarded along with
its evidence.

The Backend Layer comprises two services that run side by side on one machine and
manage communication, persistent storage, notifications and real-time updates. A
Node.js 22 and Express 4.19 application acts as the API gateway, mounting route
modules for authentication, medications, caregiver linkage, notifications,
detection control, event logs, relationships, user items, location, user
administration and storage reporting, and running the background loops that check
medication windows, dispatch pending notifications, monitor the camera stream and
rebuild routine profiles. A Python FastAPI service hosts the detection pipeline,
the item indexer, the scene classifier, face recognition, transcription and
keyframe storage. A local MongoDB instance stores the structured data: user
profiles, event logs, medication schedules and dose records, relationships,
enrolled items, location history, notifications, messages, transcripts and
routine profiles. Visual evidence is held in five local stores on the backend
file system, organised by user and by date and governed by the thirty-six hour
retention policy; the handset itself stores no evidence, and conversation audio
is transcribed in memory and never written to disk. Socket.IO provides real-time
communication, authenticating each connection from the token presented at
handshake and delivering updates into a room specific to that user, and also
carries the signalling for voice calls, whose audio then flows directly between
the two devices rather than through the server. Firebase Cloud Messaging delivers
push notifications, reminders, deviation findings and emergency escalation to
connected devices.

The Output and Interaction Layer provides the end-user services. Users can open a
dashboard showing activity summaries, step counts, medication adherence and
behavioural information. The memory search system retrieves past events and the
frames associated with them, answering a question in natural language where a
language model is available and from a deterministic template where it is not. A
real-time activity feed displays events as they are recorded, filtered to a
chosen person and date, and the reporting modules generate behavioural summaries
and trends. Reminder services issue medication and appointment notifications. The
emergency module escalates to the caregivers linked to the account, whether
raised by the button or by the spoken phrase, and presents each caregiver with
the location and the circumstances. Caregivers can additionally audit the stored
keyframes and flag or delete them, review where each belonging was last seen,
confirm or dismiss an unrecognised face, and see what is currently being retained
and for how long.

The system integrates with a small number of external services. Email
notifications are distributed over SMTP. Google Maps and the platform location
services provide mapping, directions and geocoding for the location features,
with the web dashboard and the mobile application each using a separately
restricted API key. Google Sign-In is available as an optional means of account
linking. Firebase Cloud Messaging, described above, is the delivery channel for
push notifications. The system does not integrate with electronic health record
systems, with any third-party health API, or with emergency services; an
emergency alert reaches the user's own linked caregivers.

Communication between components uses the local network. The wearable camera
reaches the backend over Wi-Fi as an RTMP stream, and the mobile application, the
web dashboard and the two backend services communicate over HTTP and WebSocket
connections on the same network; no short-range radio link such as Bluetooth is
used. Every request carries a signed token, which is also checked at socket
handshake and pinned to the connection for its lifetime, so that a client cannot
act on behalf of another user. Transport encryption is not currently configured:
traffic is plain HTTP on a trusted local network, and terminating TLS is a
prerequisite for any deployment beyond it. Client API keys that necessarily ship
inside the mobile application are restricted by package name and signing
fingerprint rather than concealed, and the server-side credentials and service
account key are excluded from version control.

---

## Component, technology and security summary

| Component | Description | Technology Used | Security Mechanism |
|---|---|---|---|
| Mobile application | User interface, memory search, reminders, emergency raising, caregiver views; no inference performed on the device | Flutter 3.35.3 / Dart 3.9.2, Android; `speech_to_text` 7.0, `sensors_plus` 7.1, `pedometer` 4.0, `shared_preferences` 2.5 | Signed session token on every request and at socket handshake; Maps key restricted to the package name and signing fingerprint; service token cleared on sign-out |
| AI backend | Detection pipeline, object and pill detection, belonging identification, face recognition, scene classification, transcription, keyframe storage and retention | Python 3.11, FastAPI 0.136.1 under Uvicorn, ONNX Runtime 1.24.2, PyTorch, OpenCV 4.13, MediaPipe 0.10.14, PyMongo 4.7.2 | Bound to the loopback interface; its routes are not individually authenticated and CORS is unrestricted, so it relies on not being reachable from outside the machine |
| REST API | Business logic, event ingestion, notification dispatch, memory search, medication windows, routine profiles | Node.js 22.22.3 / Express 4.19.2, Mongoose 8.4 | `jsonwebtoken` 9.0.2 with a seven-day expiry; `bcryptjs` 2.4.3 password hashing; role-based route authorisation; Google Sign-In verified through `google-auth-library` 10.9. CORS is unrestricted, and a request carrying the `x-internal` header is trusted as the AI backend |
| Real-time channel | Live activity updates, alerts, chat and call signalling | Socket.IO 4.8.3 | Token verified at handshake and the identity pinned to the connection for its lifetime; each user has a private room, so no client receives another user's events |
| Primary database | Event records, user profiles, medication schedules and dose logs, relationships, enrolled items, location history, messages, transcripts, routine profiles | MongoDB, local instance, with Mongoose ODM | Access control enforced in the application layer rather than by the database; no encryption at rest and no database-level roles |
| Evidence storage | Keyframes, item crops, activity frames, social frames and medication evidence | Local file system, five stores under the AI backend, `<store>/<user>/<date>/` | Served only to the person captured, a caregiver linked to them, or the AI backend; the browser's `<img>` tags use a separate frame-scope token valid for sixty minutes rather than the session token; everything is deleted after thirty-six hours unless flagged. Conversation audio is never written to disk |
| Caregiver dashboard | Real-time activity feed, location map, medication status, alert management, keyframe audit, storage report | React 19.2 with Vite 6.4, `@react-google-maps/api` 2.20.8, Socket.IO client 4.8.3 | Session token held in browser storage with a seven-day expiry; caregiver scope limited to the users they are linked to. There is no second factor and no idle timeout |
| Voice calls | Caregiver and wearer speech | `flutter_webrtc` 1.6.2 on Android, native WebRTC in the browser | Signalling relayed only between parties with an existing caregiver link; audio flows directly between the two devices and is encrypted by WebRTC's own DTLS-SRTP — the only encrypted transport currently in use |
| Notification services | Push and email delivery with escalation and retry | Firebase Cloud Messaging v1 through `firebase-admin` 14.1.0; SMTP through `nodemailer` 6.9 | Service account key excluded from version control; TLS on the outbound connections to Google and the mail provider. No APNs and no SMS channel |
| Camera ingest | Wearable camera stream | GoPro publishing RTMP to MediaMTX, republished as RTSP per user | Reachable only on the local network, on a path specific to the user; the stream itself is not authenticated |

## Tier descriptions

**Tier 1 — Presentation Tier.** The Flutter mobile application and the React
caregiver dashboard reside here. These components handle all user interaction
and rendering, and validate input at the form before it is submitted. The
interfaces are built for the users they serve, with large touch targets and
type that remains legible when enlarged; the caregiver summary grid is
regression-tested at a 360 dp width under both normal and enlarged system text,
so a reader with larger type set does not lose information off the edge of the
screen. Neither client reaches the database directly: both communicate solely
through authenticated API calls over HTTP and a token-authenticated socket
connection.

**Tier 2 — Device Tier.** This tier covers what the devices themselves do. The
wearable camera publishes its stream to a server on the local network. The
smartphone contributes the data only it can produce: location fixes, step
counts, fall detection from the accelerometer, and speech recognition for
memory-search queries and the spoken emergency phrase, each of which is reduced
to a structured result on the handset and submitted rather than streamed. Frame
analysis is deliberately not performed here. The models the system depends on
are too large for the handset and would exhaust its battery, so inference was
placed on the backend machine; the consequence, stated plainly, is that
detection requires that machine to be reachable.

**Tier 3 — Application Tier.** The Node.js and Express application holds the
business logic, organised as route modules within one deployable service:
authentication, event ingestion, memory search, medications, caregiver linkage,
relationships, user items, location, notifications, user administration and
storage reporting. Alongside it, a Python FastAPI service holds inference and
the keyframe stores. Each module owns its domain logic and its data access, and
modules collaborate through direct function calls within the process; the two
services communicate over HTTP, and both deliver updates to clients over
Socket.IO rather than through any message broker or database change stream.
Scheduled work runs in this tier: a single cron tick each minute checks
medication windows, reminder escalation and pending notification deliveries,
including an automatic retry for those that failed; routine rules are
evaluated every thirty seconds, routine profiles rebuilt daily, a batch
reconciliation runs nightly at two o'clock, and the camera stream is polled
every three seconds.

**Tier 4 — Data Tier.** Structured data is held in MongoDB with Mongoose
providing schema validation, and binary media is held in local evidence stores
on the backend file system. Access patterns are indexed rather than left to
collection scans: event logs, location history, medication logs, keyframe
metadata, routine findings, messages and notifications each carry a compound
index on the owning user and the time field they are queried by, with further
compound indexes for the specific filters the dashboard issues, a unique index
on the user and date of a step record to make a day's count idempotent, and
partial indexes on the notification retry fields so the dispatch sweep examines
only what is actually outstanding. Media is never exposed by a public path: a
frame is served only to the person it was captured from, a caregiver linked to
them, or the AI backend, and the browser receives a separate frame-scope token
valid for sixty minutes instead of the session token. All stored evidence
expires after thirty-six hours unless a caregiver has flagged it, so the data
tier shrinks on its own rather than accumulating.

Two entries in the table above deserve a note rather than a cell. Traffic
between every component is plain HTTP on the local network;
WebRTC audio is the exception. The `x-internal` header is trusted without a
shared secret, which is acceptable while the AI backend and the API share one
machine and is the first thing to change if they do not.

---

## Interface and data flow description

The wearable camera publishes a live video stream over Wi-Fi as RTMP to a
MediaMTX server on the local network, which republishes it as RTSP on a path
unique to the wearer. The inference service reads that path at 1280x720 and up
to five frames per second. The link is ordinary Wi-Fi rather than a
point-to-point or short-range radio channel: there is no Wi-Fi Direct pairing
and no Bluetooth channel, so the camera reports no battery telemetry and
accepts no control signals from the system. Audio does not travel with the
video, because the capture interface the pipeline reads frames through cannot
carry an audio track at all. The camera has no intelligence of its own; all of
it is in the inference service.

The Flutter mobile application performs no frame analysis. It is the wearer's
and the caregiver's interface, and the source of the signals only a handset can
produce: location fixes, streamed on movement of ten metres, step counts, fall
detection from the accelerometer, and platform speech recognition for
memory-search queries and the spoken emergency phrase. Each of those is reduced
to a structured submission rather than streamed, and the application holds no
computer vision or model runtime of any kind. Through it the wearer receives
medication reminders, opens a walking route home, searches their day, reviews an
activity summary and controls privacy; the caregiver reaches the family list, a
per-person emergency screen, the activity feed, the keyframe audit, relationship
management and the storage report. Both roles exchange messages and place
peer-to-peer voice calls, whose audio flows directly between the two devices.

The Python inference service is where the system's intelligence sits. It
maintains the rolling buffer of recent frames that each detector analyses, and a
thirty-second in-memory ring buffer of audio captured from the microphone of
the machine it runs on, from which the transcriber reads windows and keeps only
text — no code path in that module opens a file, and audio capture is optional,
so a machine without a microphone runs the pipeline unchanged. Within the
service, object detection proposes candidate regions and supplies the vocabulary
for naming a room, a pill detector and hand landmarks together decide whether a
medication gesture occurred, two embedding stages identify a belonging against
the wearer's enrolled galleries, faces are matched against the wearer's
confirmed relationships, and room sessions are assembled from scene
classifications. The service writes its conclusions as structured event records
— a timestamp, an action type, a confidence score, the keyframe identifiers
and, where relevant, the item or person concerned — through the application API,
and writes the frames themselves to the evidence stores on its own file system.

The Node.js and Express application is the authoritative backend for every
client. It exposes REST endpoints for authentication, event ingestion, memory
search, medication management, caregiver operations, relationships, enrolled
items, location, notifications, user administration and storage reporting. It
holds no server-side session state — there is no session store, and each
request is authenticated from the signed token it carries — so additional
instances could be placed behind a load balancer once the two in-memory
components noted under the scalability requirements were addressed. Push
notifications are delivered through Firebase Cloud Messaging and email through
SMTP; there is no Apple Push Notification Service integration, because the
application is built for Android. Real-time updates reach the dashboard and the
handset by Socket.IO emission into a room specific to the user they concern,
authenticated at handshake.

All structured data is stored in a local MongoDB instance: user profiles, event
records, keyframe metadata, medication schedules and dose logs, routine
profiles and findings, location history, relationships, enrolled items,
messages, transcripts, notifications and step counts. Real-time delivery to the
caregiver dashboard is by Socket.IO emission on write rather than by database
change streams, which require a replica set this deployment does not have.
Binary media — keyframes, item crops, activity and social frames, and
medication evidence — is written to five stores on the inference machine's file
system, organised by user and date, served only to the person captured, a
caregiver linked to them, or the inference service, and deleted thirty-six
hours after capture unless flagged. A browser image tag is authorised by a
separate frame-scope token valid for sixty minutes rather than by the session
token. Transcripts are stored as text only; the audio they came from is never
written anywhere. The Google Maps API powers the caregiver's location map, and
route guidance is a handoff: the application opens a walking-directions URL in
the installed Maps application, which provides the turn-by-turn guidance
itself.

---

## Software interface requirements

The requirements below describe how LOCUS connects to external software
elements. Versions are those the system is built and tested against.

**SI-1: MongoDB (primary database).** The backend connects to a MongoDB
instance running locally at `mongodb://127.0.0.1:27017/locusDB` to store and
retrieve all structured data: user profiles, medication schedules and dose
records, event records, keyframe metadata, GPS location history, relationships,
enrolled belongings, messages, transcripts, routine profiles and caregiver
configuration. The instance is a single `mongod` with no replica set and no
encryption at rest; nothing is hosted.

**SI-1.1: Mongoose ODM 8.4.** All Node.js-to-MongoDB access passes through
Mongoose, which provides schema validation, query building and connection
pooling. Schema validation is the system's input validation at the data
boundary.

**SI-1.2: Socket.IO 4.8.3 (real-time updates).** Real-time data reaches the
caregiver dashboard and the mobile application by server-initiated Socket.IO
emission rather than by polling, which is what keeps the live activity feed and
the location map current. Each connection is authenticated from the token
presented at handshake, that identity is pinned to the connection for its
lifetime, and events are emitted into a room specific to the user they concern.
MongoDB Change Streams are not used; the application emits on write, which does
not require a replica set.

**SI-2: Node.js 22.22.3 / Express 4.19.2 (backend API).** The mobile
application and the web dashboard communicate with a RESTful API exchanging
JSON. This API is the only path by which a client reaches stored data: neither
client holds database credentials nor contacts the inference service directly.
Transport is plain HTTP on the local network; TLS is not configured, and
terminating it is a precondition for any deployment beyond that network.

**SI-3: Google Maps JavaScript API, through `@react-google-maps/api` 2.20.8.**
The caregiver dashboard renders an interactive map showing the monitored
person's most recent GPS fix and their registered home address as markers.
Geofence boundaries are not drawn as overlays: the home radius and each
sensitive place are stored with a radius and evaluated on the server, and the
dashboard reports the result rather than the geometry. Belongings are located
by the frame in which they were last recognised; no item carries a GPS tag, so
there are no item position pins.

**SI-3.1: Google Maps handoff for route guidance.** When the wearer needs to
get home, and when a caregiver needs to reach a person who has raised an
emergency, the application constructs a Google Maps directions URL and opens it
in the installed Maps application, which then provides turn-by-turn guidance.
The Navigation SDK is not embedded and LOCUS does not render or speak the route
itself; it hands the destination to an application already present on the
device. The wearer's route home is requested in walking mode.

**SI-4: Local evidence storage.** Binary media — extracted keyframes, item
crops, activity frames, social frames and medication evidence — is written to
five stores on the file system of the machine running the inference service,
organised as `<store>/<user_id>/<date>/`. There is no object-storage service
and no AWS SDK in the project. A frame is served only to the person it was
captured from, a caregiver linked to them, or the inference service itself;
because an `<img>` tag cannot carry an Authorization header, the browser is
issued a separate frame-scope token valid for sixty minutes rather than the
session token, so what appears in a URL, a Referer header or a server log is
nearly worthless. Every stored frame is deleted thirty-six hours after capture
unless a caregiver has flagged it. Conversation audio is transcribed in memory
and is never written to storage.

**SI-5: Backend model stack (ONNX Runtime 1.24.2 and PyTorch).** All model
inference runs on the machine hosting the inference service, not on the
handset. Object detection uses a YOLO11n model trained on Objects365, whose 365
classes supply both the candidate regions for belonging identification and the
vocabulary from which a room is named; a separate single-class ONNX model
locates pills at 640x640; MediaPipe Hands 0.10.14 supplies twenty-one
three-dimensional landmarks per hand; MobileNetV3-Small and DINOv2 ViT-S/14
embeddings perform the two stages of belonging identification; InsightFace
buffalo_l embeds faces; and faster-whisper transcribes speech. TensorFlow Lite
is not used, and no `.tflite` model is deployed. The only machine learning
performed on the handset is the platform's own speech recognition, used for
memory-search queries and the spoken emergency phrase.

**SI-6: OpenCV 4.13 (computer vision).** OpenCV runs in the inference service,
where it decodes the incoming stream, selects frames for storage, encodes them
as JPEG, and applies blurring. Blurring is applied to the whole frame when the
wearer has selected blurred capture, not selectively to bystanders' faces; the
system does not attempt to detect and obscure individual faces, and the
privacy guarantee it offers is therefore the stronger and simpler one that
nothing in the frame is legible. OpenCV does not run on the handset.

**SI-7: JWT authentication (`jsonwebtoken` 9.0.2).** The API uses stateless
session management: there is no session store, and every authenticated request
carries a signed token in the `Authorization: Bearer` header, which is also
verified at Socket.IO handshake. A session token carries the user's identifier
and role and expires after seven days, configured by `JWT_EXPIRES_IN`.
Passwords are hashed with `bcryptjs` 2.4.3, and Google Sign-In assertions are
verified through `google-auth-library` 10.9. Two shorter-lived tokens exist for
narrower purposes: the sixty-minute frame-scope token described in SI-4, and a
fifteen-minute password-reset token which is signed with the user's current
password hash appended to the server secret, so that it stops verifying the
moment the password changes and cannot be replayed after use.

**SI-8: Firebase Cloud Messaging and SMTP (notification delivery).** Push
notifications are delivered through the FCM v1 API using `firebase-admin`
14.1.0 against a service account credential excluded from version control, and
email through `nodemailer` 6.9 over an authenticated SMTP connection. Delivery
state is recorded per channel on each notification and retried automatically by
the scheduler. There is no APNs integration, because the application is built
for Android, and no SMS channel.

**SI-9: MediaMTX (stream ingest).** The wearable camera publishes an RTMP
stream to a MediaMTX server on the local network, which republishes it as RTSP
at `rtsp://<host>:8554/live/<user_id>`. The inference service reads frames from
that path at 1280x720, adapting its rate up to five frames per second. The
stream is reachable only on the local network and is not itself authenticated.

**SI-10: WebRTC (voice calls).** Voice calls use `flutter_webrtc` 1.6.2 on
Android and the browser's native WebRTC implementation on the dashboard. The
API relays only the signalling, and only between parties with an existing
caregiver link; the audio itself flows directly between the two devices,
encrypted by WebRTC's own DTLS-SRTP. It is currently the only encrypted
transport in the system.

---

## Operating environment

LOCUS operates across four interconnected environments.

**Wearable camera.** A consumer action camera worn on the chest, configured to
publish a live RTMP stream over Wi-Fi to the MediaMTX server on the local
network. The camera does not pair with the smartphone and the smartphone is not
in the video path: the stream travels from the camera to the stream server
directly, and the inference service reads it from there at 1280x720. The camera
is powered by an external USB power bank, which is what makes a continuous
recording session of several hours possible; live streaming draws considerably
more power than recording to the card, so run time is bounded by the power bank
rather than by the camera's own battery.

**Mobile application (Android).** Developed in Flutter 3.35.3 with Dart 3.9.2
and built for Android. The project does not raise the minimum SDK level, so the
floor is the Flutter toolchain's default rather than a value chosen for this
system, and the application has been tested on one handset, a Galaxy A06 at
720x1600. It requires GPS hardware for location features, microphone access for
memory search and the spoken emergency phrase, and a Google Play Services
installation for push notifications. It requires network reachability to the
backend for every feature: the application discovers the backend's address on
the local network rather than using a fixed endpoint, and because reminders are
dispatched by the server and only displayed locally — `flutter_local_notifications`
is used to present a notification that has already arrived, never to schedule
one — there is no offline mode. Without a reachable backend the application can
show the session it already holds and nothing further.

**Web dashboard (caregiver).** A React application served by Vite, used in a
current desktop browser. It requires network reachability to the backend, and
supports more than one caregiver per monitored person, with the routes a
caregiver may use and the people whose data they may see both enforced on the
server from the role and the links on their account rather than in the
interface.

**Backend machine.** One Windows desktop on the same local network hosts
everything else: the Express API, the Python inference service, the MediaMTX
stream server, the MongoDB instance and the five evidence stores. Nothing is
hosted off that machine, and it is the single point of failure for new
detection, although escalation, reminders and access to records already
captured continue while only the inference service is down. Outbound
connectivity is required for three things and no others: Firebase Cloud
Messaging, the SMTP provider, and the Google Maps tiles the dashboard and the
handset request.

---

## Design and implementation constraints

**Hardware.** The system is built on consumer off-the-shelf hardware, an action
camera and an Android handset, and inherits their limits. Run time is bounded
by the external power bank the camera is driven from, because live streaming
draws considerably more than recording to a card. There is no audio or visual
output path on the camera itself: everything the system says to the wearer is
said by the handset, so an interaction the wearer cannot hear from a pocket is
an interaction they will miss. Storage is bounded by what is kept rather than
by the video rate, because video is never retained: frames are selected and
written as JPEGs of roughly 110 kB each, subject to a per-event cooldown of
four seconds for medication evidence, eight for a scene change, fifteen for an
activity frame and twenty for an item or social frame. The arithmetic ceiling
is therefore on the order of two hundred megabytes per hour, in the
pathological case where every detector fires at its cooldown without pause,
and is far lower in practice; the thirty-six hour retention window bounds the
total regardless.

**Connectivity.** The constraint is reachability of the backend machine on the
local network, not internet access. Face recognition, belonging
identification, medication detection, scene classification, transcription and
memory retrieval all require that machine, because that is where the models
run. Internet access is additionally required for push notification delivery,
outgoing email and map tiles. There is no offline mode: reminders are
dispatched by the server and only displayed on the handset, so an unreachable
backend means no reminders rather than cached ones.

**Privacy regulation.** The system must comply with applicable data protection
regulation, and continuous audio capture is restricted in jurisdictions that
require the consent of all parties to a conversation. Three properties of the
build respond to this directly. The wearer controls capture: privacy mode
refuses frames and governs the microphone by the same switch, and a refusal is
logged with its reason rather than passing silently. Conversation audio is
transcribed in memory and never written to disk, so no recording of a
bystander's voice exists to be disclosed or subpoenaed. And a room the wearer
marks as sensitive triggers retroactive deletion of the stretch recorded there,
which requires corroboration from a second frame before anything is destroyed,
because an erroneous deletion cannot be undone. Everything retained expires
after thirty-six hours unless a caregiver has flagged it, so the quantity of
personal data held at any moment is bounded by design rather than by policy.

**Medical device exclusion.** LOCUS is an assistive tool and must not function
as a medical device. It offers no diagnosis, no dosing or prescription
guidance, and no emergency medical service. Its medication feature records
evidence that a dose appeared to be taken at a scheduled time and surfaces a
missed window to a caregiver; it does not identify which medication was taken,
and does not advise. An emergency escalation reaches the caregivers linked to
the account, not an emergency service, and the interface states this.

**Performance.** All inference runs on the CPU of a single desktop machine,
which is the binding performance constraint. The system responds to it in three
ways: the frame rate read from the stream adapts to the processing load up to a
ceiling of five frames per second, the inference runtime is held to one fewer
thread than the machine has cores so the machine stays responsive, and the
number of candidate regions verified per frame is bounded by an explicit budget
so that a crowded frame costs no more than a sparse one. There is no on-device
inference to constrain, and consequently no handset battery cost from model
execution; the handset's power cost is the camera-independent one of location,
step counting and a maintained socket connection.

**Scope.** Three capabilities are deliberately bounded. Pill detection locates
a pill-shaped object; it does not identify which medication it is, so adherence
is inferred from the schedule, the hand gesture sequence and the evidence
frames rather than from the identity of the tablet. Gallery adoption, by which
a confirmed sighting could extend an item's reference set, is implemented but
capped and disabled by default, because judging a new sighting against a
gallery that has itself grown by adoption is how such a mechanism drifts; the
system therefore does not improve itself unattended. Integration with
electronic health record systems is not implemented at all, in any form, and is
noted here as excluded rather than partial.

---

## Backend process requirements — event-response table

Backend behaviours triggered by automated events rather than by direct
interface interaction.

| Event | Trigger | Source | State (before) | Response | State (after) | Exception handling |
|---|---|---|---|---|---|---|
| Medication dose unverified | The two-hour verification window closes with no verified dose | Scheduler cron tick, every 60 s | Reminders sent; dose awaiting verification | 1. Mark the dose `missed` if the camera was recording, or `camera_off` if it was not 2. Set the caregiver-notified flag 3. Notify every linked caregiver and the wearer, by push and email 4. Record the outcome against the dose log | Dose closed as `missed` or `camera_off`; recipients notified | Each channel retries up to three times with a 1, 5 and 15-minute backoff, gives up after two hours, re-checks the recipient's channel preferences before every attempt, and stops chasing a notification that has been dismissed or acknowledged |
| Emergency raised | Emergency button, or a recognised spoken phrase after a five-second cancellable countdown | Wearer's handset | Normal monitoring | 1. Set the emergency flag and its timestamp 2. Emit the alert into every linked caregiver's room immediately, before any notification text is composed 3. Create one acknowledgement-required notification per caregiver, delivered by push and email, with a fixed title | Emergency active; the fix supplied with the trigger is shared with caregivers | Refused with 400 if the account has no linked caregiver, since there is no one to alert. The live socket emission deliberately precedes notification composition so that one slow recipient cannot delay the next. Remains active until cleared by the wearer or by a caregiver |
| Routine finding raised | One of six rules: a medication gap over consecutive days, three hours without movement, hours of waking time with no frames, an expected scene absent at its usual hour, an item usually carried but absent, or an enrolled item left behind | Routine monitor, every 30 s | Baseline profile in force | 1. Write the finding with a deduplication key 2. Choose recipients by the subject's role — a finding about an elderly user goes to their caregivers, a finding about a normal user to that user, and an item finding to the wearer first 3. Choose channels by severity: urgent gives push and email and requires acknowledgement, warning gives push and email, informational gives push only | Finding recorded whether or not it was surfaced; recipients notified | The deduplication key is the suppression mechanism, and its scope is set per rule rather than by a fixed window: once per hour for a scene deviation, once per day for a camera-off or inactivity finding, once per sighting for an item left behind. A duplicate insert is rejected by a unique index, so running the monitor more often cannot produce a second alert |
| Item left behind | An enrolled item was last seen put down rather than in the hand, has not been seen since, and ten minutes have passed | Routine monitor | Item sighting recorded with its room | Notify the wearer, naming the room the item was left in and the time, with the frame that saw it | Wearer notified; finding recorded | Informational severity, so push only and no escalation: the person standing nearest the item is the person who can retrieve it. An item last seen in the hand is never reported, because it went with them |
| Item loss escalation | The wearer has moved more than 75 m from where an enrolled item was put down, and has not acknowledged the alert within ten minutes | Routine monitor | Acknowledgement-required alert sent to the wearer | 1. Escalate to every linked caregiver 2. Attach the last-seen time, the coordinates and a map link, appended after the message text is composed 3. Attach the keyframe that last saw the item, resolvable through the authenticated image route 4. Deliver by push and email 5. Record the escalation on the finding | Caregivers notified with location and visual evidence; escalation recorded | Same three-attempt retry and backoff as any other delivery. No escalation occurs if the account has no linked caregiver. Escalation is scoped to this rule alone; no other informational finding escalates |
| Unacknowledged alert escalation | A notification requiring acknowledgement is neither acknowledged nor dismissed fifteen minutes after creation | Scheduler cron tick | Alert delivered, awaiting acknowledgement | Claim the notification by a compare-and-set on its own record, then escalate it once | Alert marked escalated with its timestamp | The claim is what makes this safe: two overlapping passes, or a second server process, cannot escalate the same alert twice |
| Confidence-band classification | The detection pipeline computes a weighted confidence for a completed three-phase medication sequence | Detection pipeline | Sequence detected; confidence computed | At 0.85 or above, record the dose as verified. Between 0.70 and 0.85, record it as pending confirmation together with its evidence frames. Below 0.70, discard it and retain no frame | Dose verified, pending confirmation, or discarded | Both thresholds are overridable per user. There is no confirmation timeout: a pending dose waits for a person to answer rather than being discarded on a timer, because a discarded pending dose would be indistinguishable from one never detected. An evidence frame is written only for a dose that is actually recorded, so a rejected detection leaves no photograph of the wearer |
| Camera stream lost or returned | The stream monitor finds the per-user RTSP path unreadable, or readable again | Stream monitor, every 3 s | Pipeline running, or stopped | On loss, stop the pipeline and record that capture ended. On return, restart it without intervention | Pipeline state matches stream availability | A medication window that opens while the camera is off is held rather than closed as missed, and closes as `camera_off` rather than `missed` if the camera never returns — the system does not assert that a dose was skipped during a period it was not watching |
| Retention expiry | A stored frame reaches thirty-six hours of age | Retention sweeper, every 30 minutes | Frame and its metadata stored | Delete the frame, its metadata and any cached thumbnail derived from it, across all five evidence stores | Frame removed; storage footprint bounded | A frame a caregiver has flagged is retained. Thumbnails are removed with the frame they came from, so a deleted frame cannot survive as a cached rendering |

## Functional requirements derived from the event-response table

| Event | Functional requirement | Business rule |
|---|---|---|
| Medication dose unverified | **FR-E1.1:** The system shall close a medication dose as unverified when its two-hour verification window passes without a verified intake. | A dose is closed once per scheduled instance. It is marked missed only if the camera was recording during the window; if it was not, it is marked camera-off, because the system may not assert a skipped dose for a period it was not watching. |
| Medication dose unverified | **FR-E1.2:** The system shall notify the wearer and every linked caregiver when a dose closes unverified. | Delivered by push and email. Each channel is retried up to three times at one, five and fifteen minutes, abandoned after two hours, and not retried at all once the recipient has dismissed or acknowledged the alert. |
| Emergency raised | **FR-E2.1:** The system shall activate emergency state on an emergency trigger and share the location fix supplied with it. | Emergency state remains active until cleared by the wearer or by a caregiver. Location reporting is continuous independently of the emergency, streamed from the handset on movement of ten metres; the emergency carries the fix taken at the moment it was raised. |
| Emergency raised | **FR-E2.2:** The system shall alert every linked caregiver on activation. | The live socket alert is emitted to all caregivers before any notification text is composed, so that composing a message for one recipient cannot delay the alert to another. An account with no linked caregiver cannot raise an emergency, and is told so rather than failing silently. |
| Emergency raised | **FR-E2.3:** The system shall give the wearer a route home and both parties a voice channel on request. | Route guidance is a handoff: the application opens a walking-directions URL in the installed Google Maps application. A voice call is initiated by either party and is not opened automatically, so no microphone is activated without an action. |
| Routine finding | **FR-E3.1:** The system shall evaluate the wearer's day against the learned baseline and record a finding where a rule is met. | A finding is recorded whether or not it is surfaced to anyone, so that the monitor's behaviour can be audited separately from its alerting. |
| Routine finding | **FR-E3.2:** The system shall route each finding to the recipients appropriate to its kind. | A finding about an elderly user goes to their caregivers; a finding about a normal user goes to that user; an item finding goes to the wearer first, because the person beside the item is the person who can retrieve it. An idle check-in reaches the wearer only and never a caregiver. Severity selects the channel: urgent gives push and email with acknowledgement required, warning gives push and email, informational gives push only. |
| Routine finding | **FR-E3.3:** The system shall not deliver the same finding twice. | Suppression is by a deduplication key whose scope is defined per rule — hourly for a scene deviation, daily for camera-off and inactivity, per sighting for an item left behind — and enforced by a unique index rather than by a timer, so a more frequent monitor pass notices sooner without alerting twice. |
| Item loss escalation | **FR-E4.1:** The system shall escalate an unacknowledged item-loss alert to caregivers with the item's last known location and the frame that last saw it. | Escalation occurs ten minutes after the alert if the wearer has not acknowledged it, and only for the rule where the wearer has moved more than seventy-five metres from the item. The map link is appended after the message is composed, never handed to the phrasing step. |
| Unacknowledged alert | **FR-E4.2:** The system shall escalate any acknowledgement-required alert that remains unacknowledged. | Fifteen minutes after creation, and exactly once: the record is claimed by a compare-and-set before the escalation is sent. |
| Confidence classification | **FR-E5.1:** The system shall record a detected dose without prompting when its confidence reaches the automatic threshold. | Default 0.85, overridable per user. The dose and its evidence frames become visible in the activity feed immediately. |
| Confidence classification | **FR-E5.2:** The system shall record a dose in the confirmation band as pending and ask a person to confirm it. | Default band 0.70 to 0.85. A pending dose is not discarded on a timer: it waits for an answer, because a dose discarded for silence would be indistinguishable from one never detected. |
| Confidence classification | **FR-E5.3:** The system shall discard a detection below the confirmation threshold and retain no imagery from it. | The evidence frame is written only for a dose that is actually recorded, so a rejected detection leaves no photograph of the wearer. The decision and its score are logged for threshold review; the image is not. |
| Camera availability | **FR-E6.1:** The system shall resume detection without intervention when a lost camera stream returns. | The stream is polled every three seconds. A medication window that opens while the camera is off is held rather than closed. |
| Retention | **FR-E7.1:** The system shall delete stored evidence thirty-six hours after capture. | Swept every thirty minutes across all five stores. A frame a caregiver has flagged is kept; cached thumbnails are deleted with the frame they were derived from. |

---

# Non-functional requirements

## Reliability

REL-1: The camera stream shall be polled every three seconds, and a detection pipeline shall restart without operator intervention when a lost stream becomes readable again.

REL-2: A medication verification window that opens while the camera is off shall be held rather than closed, and a dose the camera did not observe shall be recorded as camera-off rather than as missed.

REL-3: Push and email shall be independent delivery channels, dispatched in parallel rather than one as the other's fallback, each recording its own sent state, failure state, attempt count and next attempt time on the notification record.

REL-4: A failed delivery shall be retried up to three times, at one, five and fifteen minutes, abandoned after two hours, with the recipient's channel preferences re-checked before every attempt and no further attempt once the alert has been acknowledged or dismissed.

REL-5: A channel that exhausts its attempts shall remain marked as failed with its attempt count, so that an undelivered alert is recorded rather than absent.

REL-6: Scheduled work shall be guarded against duplication both within a process, by a lease that prevents a tick overlapping itself, and across processes, by a compare-and-set claim on each record before it is acted upon.

REL-7: Captured evidence shall be written to exactly one place, the backend file system. Nothing shall be buffered on the camera and nothing stored on the handset.

## Usability

USE-1: The wearer shall be able to raise an emergency from the Home tab in two interactions: one press of the emergency control, followed by a five-second cancellable countdown.

USE-2: The wearer shall be able to raise the same escalation by speaking a recognised phrase, which arms the identical countdown.

USE-3: A caregiver shall be linked only through an in-app invitation accepted by the person to be monitored.

USE-4: A caregiver shall reach a family member's medication status from the dashboard home in three interactions: the family list, the member, then their medication panel.

USE-5: Reminders, findings and alerts shall be composed from the counts and times the monitor found, with the classifier's internal keys converted into English, and the phrasing step shall be unable to introduce a finding, a number or a link that the deterministic layer did not produce.

USE-6: An invalid entry shall be answered with a message naming the field that caused it rather than a generic failure.

USE-7: The caregiver summary grid shall render without layout overflow at 360 dp under system text scaling of 100 and 130 per cent, verified by an automated test.

## Performance

PER-1: A medication reminder shall be dispatched in the scheduler tick that follows its due moment, the tick interval being sixty seconds.

PER-2: The read rate from the camera stream shall adapt to processing load up to a ceiling of five frames per second.

PER-3: The inference runtime shall be held to one fewer thread than the machine has cores.

PER-4: The number of candidate regions verified in a frame shall be bounded by an explicit budget, so that a crowded frame costs no more verification than a sparse one.

PER-5: Every event query shall be served by a compound index on the owning user and the time field queried, not by a collection scan.

PER-6: A face match shall be a cosine comparison against only the faces that wearer has confirmed, so that its cost does not grow with the number of users in the system.

PER-7: The caregiver dashboard overview shall be assembled from the application API alone, so that it loads while the inference service is unavailable.

PER-8: No model inference shall run on the handset.

## Security

SEC-1: A caregiver shall reach a family member's data only after that family member has linked them, enforced on the server in route authorisation, in frame access and in call signalling, rather than in the interface.

SEC-2: A socket connection's identity shall be fixed at handshake for the lifetime of the connection.

SEC-3: A stored frame shall be served only to the person it was captured from, a caregiver linked to them, or the inference service.

SEC-4: A frame requested by a browser image tag shall be authorised by a separate frame-scope token valid for sixty minutes, never by the session token.

SEC-5: A password reset token shall be valid for fifteen minutes and shall be signed with the account's current password hash, so that it stops verifying the moment the password changes.

SEC-6: Passwords shall be stored only as bcrypt hashes.

SEC-7: Blurring shall be applied to the whole frame before it is written, and no unblurred copy shall be produced at any point. Derived crops shall inherit the blur.

SEC-8: While capture is paused, a frame shall be refused before it is written, and the refusal shall be recorded with its reason.

SEC-9: Conversation audio shall be transcribed in memory and never written to storage.

SEC-10: Retroactive deletion of a stretch recorded in a room the wearer has marked sensitive shall require corroboration from a second frame before anything is destroyed.

SEC-11: Stored evidence shall be deleted thirty-six hours after capture unless a caregiver has flagged it, and a frame's cached thumbnails shall be deleted with it.

The following are not implemented and are recorded here as gaps rather than requirements: transport encryption, which is absent except for voice call audio under WebRTC's own DTLS-SRTP; encryption at rest for the database and the evidence stores; an idle session timeout, a second authentication factor, and account lockout after repeated failed logins; and a persistent application error log, failures other than notification delivery being written to the process console only.

## Maintainability

MNT-1: A detector shall implement a common interface — an action type, a model name, a predicate stating when it applies, and an analysis method returning a result or nothing — and shall be declared in a single registry module, so that adding one requires no change to the capture loop.

MNT-2: Detector registration shall be lazy, so that a detector which is switched off does not load its model weights at start-up.

MNT-3: A detector declared with its enabled flag false shall be documented and skipped rather than silently absent.

MNT-4: Capture cooldowns, retention and retry windows, monitor intervals, inactivity and camera-off thresholds, the item-gone delay and the service addresses shall be read from environment variables with defaults rather than hard-coded.

MNT-5: Medication confidence thresholds shall be held per user on the user record and shall override the defaults when a pipeline starts.

MNT-6: Every behavioural rule that has produced a defect shall carry a regression test. The Python suites under the AI backend and the three Flutter test files in the mobile application hold these.

## Scalability

SCL-1: The backend shall be deployable as independently startable services. The Express application and the FastAPI inference service start separately, hold no shared memory, and communicate over HTTP through a single configurable address, so a second machine can host inference by changing one environment variable.

SCL-2: The Node.js API shall hold no server-side session state. There is no session middleware and no session store; every request is authenticated from a signed token it carries, and user identity is resolved per request.

SCL-3: Collection schemas and indexes shall be organised so that sharding by user can be enabled without schema change. Every high-volume collection carries a compound index beginning with the user identifier, and the one unique index in the schema is prefixed by it, so it remains valid under a user shard key.

SCL-4: Stored visual evidence shall be bounded rather than cumulative. Storage per user converges to a function of the retention window and the capture rate rather than growing with the time the system has been in use.

Two components would require change before a second API instance could be added: Socket.IO rooms are held in each process's memory, and the routine learner, routine monitor and event-log sweep run on in-process timers without the compare-and-set guard that protects notification dispatch.

---

# External interface requirements

## User interface requirements

UI-1: The mobile application shall follow Material Design 3; the application theme enables it.

UI-2: The mobile application shall present a bottom navigation bar on every screen, with destinations by role: a wearer sees Home, Meds, Activity, Memory and More; a caregiver sees Home, Family, Meds, Alerts and More. Settings are reached through More.

UI-3: The web dashboard shall present a persistent left-side navigation on every page.

UI-4: The mobile application shall tolerate system text scaling of 130 per cent without layout overflow in the caregiver summary grid, verified by an automated test at 360 dp.

UI-5: Error messages and alerts shall be produced by the deterministic formatting layer described in USE-5.

UI-6: The caregiver's small-screen surface shall be the mobile application, which provides the family list, the per-person emergency screen, the activity feed and the keyframe audit natively. The web dashboard is built for desktop use.

UI-7: The screens shown as mockups are illustrative of intended layout and experience and are not binding screen designs.

---

## Tools and technologies

Versions are those the system is built and run against, read from the project's
dependency manifests and the installed runtime.

| Tool / Technology | Purpose | Rationale |
|---|---|---|
| Flutter 3.35.3 | Mobile application development | One codebase and one widget library for both the wearer's and the caregiver's application; built and tested on Android |
| Dart 3.9.2 | Language for the Flutter application | Flutter's own language, with null safety, strong typing and first-class async |
| Python 3.11 | AI and inference service | The ecosystem in which the computer vision and speech models are distributed |
| FastAPI 0.136.1, Uvicorn 0.30.1 | HTTP interface of the inference service | Serves the pipeline's control and keyframe routes with no framework overhead the service does not use |
| ONNX Runtime 1.24.2 | Inference engine for the pill detector | Runs the single-class pill detection model at 640x640 on CPU, with its thread count bounded so the machine stays responsive |
| PyTorch 2.10.0 | Inference engine for the embedding models | The runtime the appearance, verification and face embedding models are published for |
| Ultralytics 8.4.14 | Object detection | Runs the YOLO11n model trained on Objects365, whose 365 classes supply both the candidate regions for belonging identification and the vocabulary from which a room is named |
| timm 1.0.29 | Verification embeddings | Provides the DINOv2 ViT-S/14 backbone that adjudicates between shortlisted belongings |
| MediaPipe 0.10.14 | Hand and gesture tracking | Supplies twenty-one three-dimensional landmarks per hand, which establish whether a detected pill is within reach of a hand rather than merely in frame |
| InsightFace 1.0.1 | Face detection and recognition | Detects faces and produces the 512-dimension embeddings matched against the wearer's confirmed relationships |
| faster-whisper 1.2.1 | Speech transcription | Transcribes rolling windows of audio to text on CPU; only the text is kept |
| OpenCV 4.13.0 | Video capture and image processing | Decodes the incoming stream, selects frames, applies whole-frame blurring and encodes JPEGs, on the backend machine |
| sounddevice 0.5.5 | Microphone capture | Fills the thirty-second in-memory audio ring buffer the transcriber reads from; already a dependency, and hands back the array the buffer needs without conversion |
| NumPy 2.2.3 | Array handling | The common representation between capture, the models and the buffers |
| PyMongo 4.7.2 | Database access from the inference service | Lets the service read schedules and write keyframe metadata without going through the API |
| MediaMTX | Camera stream ingest | Accepts the camera's RTMP publication and republishes it as RTSP on a path unique to the wearer, which is what makes the stream readable by the pipeline |
| Node.js 22.22.3 | Backend API | Hosts the application logic: authentication, caregiver management, notification dispatch and the scheduled background work |
| Express 4.19.2 | Web framework | A thin routing layer for the REST API, with the route modules mounted into one application |
| Mongoose 8.4.0 | Object document mapper | Schema validation, query building and connection pooling between Node.js and MongoDB |
| MongoDB, local instance | Primary database | Stores users, event records, medication schedules and dose logs, relationships, enrolled items, routine profiles and findings, location history, messages, transcripts, keyframe metadata, notifications and step counts |
| React 19.2.0, Vite 6.4.1 | Caregiver web dashboard | Component-based interface for the dashboard, with Vite providing the development server |
| @react-google-maps/api 2.20.8 | Map rendering | Wraps the Google Maps JavaScript API for the dashboard's location map |
| Socket.IO 4.8.3 | Real-time communication | Pushes alerts, activity updates, chat and call signalling to the dashboard and the handset, authenticated at handshake and delivered into a room specific to the user |
| firebase-admin 14.1.0 | Push notifications | Delivers reminders, findings and emergency escalation to the handset through Firebase Cloud Messaging |
| nodemailer 6.9 | Email notifications | The second, independent delivery channel for every alert that warrants one |
| flutter_webrtc 1.6.2 | Voice calls | Carries call audio directly between the two devices, encrypted by WebRTC's own transport |
| jsonwebtoken 9.0.2 | Authentication | Token-based authentication across the mobile application and the dashboard, verified on each request and at socket handshake |
| bcryptjs 2.4.3 | Password hashing | Passwords are stored only as hashes |
| google-auth-library 10.9 | Google sign-in | Verifies a Google identity assertion when a user chooses that route |
| Git 2.45.2 | Version control | Tracks changes and carries the feature branch into the main line |
| Visual Studio Code | Editor | Used for the Python, Node.js, React and Flutter work alike |
