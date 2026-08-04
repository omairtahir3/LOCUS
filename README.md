# LOCUS

LOCUS is a comprehensive, AI-powered ambient intelligence ecosystem designed to assist individuals—from everyday users managing their routines to elderly individuals living independently—while providing absolute peace of mind to their caregivers. The platform combines real-time computer vision, continuous behavioral learning, and a multi-platform architecture to actively monitor, assist, and protect users.

## Project Scope & Modules

### 1. Core Module: Real-Time Video Analysis & Keyframe Extraction
* **Dynamic Keyframe Capture:** Captures keyframes (up to 10 FPS) dynamically, increasing capture rate during motion and reducing during inactivity to save bandwidth.
* **Intelligent Event Segmentation:** Detects scene changes and action boundaries to cleanly split video streams into meaningful events (e.g., picking up keys, taking medication).
* **Rolling Buffer:** Maintains a 5-10 second rolling buffer around events to capture the full action context rather than a single isolated frame.
* **Complex Activity Recognition:** Recognizes multi-frame activities such as medication intake, doorway item-checks, and social interactions.
* **Plugin-Based Architecture:** Easily extensible AI detection pipeline allowing new detection capabilities to be added without rebuilding the core.
* **Confidence Scoring:** Analyzes full frame buffers to score confidence, reducing single-frame false positives. Auto-logs events at ≥85%, requests user confirmation at 70-84%, and discards below 70%.
* **Smart Storage Management:** Auto-deletes stored keyframes after 24-42 hours unless explicitly flagged by the user or caregiver.
* **Unified Cloud Records:** Generates and uploads structured JSON event records containing timestamps, action types, confidence scores, GPS coordinates, and keyframe IDs.
* **Adaptive AI Learning:** Learns individual user detection patterns over time, adjusting confidence thresholds to maximize accuracy. 
* **Outdoor Contextual Awareness:** Automatically loosens confidence thresholds when outdoors to adapt to variable lighting and busy backgrounds. Tracks items exiting the house and alerts users/caregivers if items disappear.

### 2. Supporting Module A: Memory Capture & Scene Input
* **Continuous Input:** Records continuous video and audio from wearable or stationary cameras.
* **Environment Classification:** Pre-classifies environments (kitchen, doorway, outdoors) before heavy analysis.
* **Audio Transcription:** Converts speech to text and attaches transcripts to event records.
* **Privacy Controls:** Instantly pauses all recording and analysis via Privacy Mode, and automatically suspends recording in user-defined sensitive locations.

### 3. Supporting Module B: Behavioral Pattern & Routine Learning
* **Routine Mapping:** Learns daily routines (medication times, exit habits, social patterns) from aggregated events.
* **Dynamic Profiling:** Maintains a personalized behavioral profile that seamlessly adapts as the user's routines change.
* **Deviation Alerts:** Sends intelligent anomaly alerts when behavior significantly deviates from the norm (e.g., missed medication, unusual inactivity, leaving without keys).

### 4. Supporting Module C: Face Recognition & Social Support
* **Facial Recognition:** Matches faces in the keyframe stream against a securely stored relationship database.
* **Interaction Summaries:** Displays past-interaction summaries for recognized individuals in the mobile app to aid memory recall.
* **Consent-Driven Updates:** Adds new faces to the relationship database only after explicit user confirmation.

### 5. Supporting Module D: Location Safety & Emergency Response
* **Continuous Tracking:** Safely streams GPS location to the cloud for item tracking and emergency use.
* **'I'm Lost' Emergency Mode:** Activated via voice command or panic button, providing real-time voice-guided navigation back home.
* **Caregiver Escalation:** Instantly shares live location and opens two-way voice communication with caregivers during emergencies.

### 6. Module 6: Activity Summary & Monitoring
* **Daily Digest:** Showcases a comprehensive daily summary including item tracking, reminders, and anomaly alerts.
* **Adherence Tracking:** Displays complete medication adherence stats (completed, missed, upcoming).
* **Intelligent Search:** Enables natural language text/voice search across the memory database, filtered by date, person, or object.
* **Storage Management:** Displays device and cloud storage utilization with one-tap cleanup suggestions.

### 7. Module 7: Memory Search & Retrieval
* **Natural Language Queries:** Search past events and memories using conversational text or voice.
* **Rich Results:** Presents search results accompanied by keyframe images, exact timestamps, and mapped GPS locations.
* **Visual Timeline:** Generates a daily timeline chronologically mapped from verified event records.

### 8. Module 8: Medication Management
* **Comprehensive Scheduling:** Full medication schedule tracking with precise dosage and timing.
* **Smart Reminders:** Configurable reminders with snooze functionality and manual dose confirmation options when camera verification is unavailable.
* **Escalation Rules:** Automatically notifies caregivers if a dose is missed after all user reminders have been exhausted.

### 9. Module 9: Caregiver Dashboard
* **Live Feed & Telemetry:** A real-time feed displaying the user's medicine status, activity state, and last-seen GPS location.
* **Interactive Mapping:** Live interactive maps highlighting real-time location and emergency alert origination points.
* **Direct Intervention:** Caregivers can send push notifications and request status checks directly to the user's device.
* **Reliable Alerting:** Escalating alerts delivered via push and email, featuring delivery tracking and auto-retry mechanisms.
* **Multi-Caregiver Support:** Role-based access control (RBAC) allowing multiple caregivers with individualized notification preferences.

### 10. Module 10: User Dashboard
* **User Interface:** An accessible, daily summary of events, routine progress, and medication compliance for all users.
* **Alert Management:** Clear list of active alerts with simple Confirm, Dismiss, and Snooze controls.
* **Privacy Toggle:** Prominent one-tap access to activate Privacy Mode.
* **Location & Item History:** Recent location history overlaid with "last-seen" markers for tracked items.

## Architecture

* **Web App (React + Node.js/Express):** Handles dashboards, RBAC, settings sync, and API routing.
* **AI Backend (FastAPI + OpenCV + Gemini):** Executes the heavy computer vision pipeline, dynamic keyframe extraction, and anomaly detection over RTSP/WebRTC streams via MediaMTX.
* **Mobile App (Flutter):** Provides the portable companion experience, push notifications (FCM), location tracking, and emergency response capabilities.

## Getting Started

1. **Web Backend:** `cd web_app/backend && npm i && npm run dev`
2. **Web Frontend:** `cd web_app/frontend && npm i && npm run dev`
3. **MediaMTX:** `cd ai_backend/detection_pipeline/mediamtx && ./mediamtx.exe`
4. **AI Backend:** `cd ai_backend/detection_pipeline && pip install -r requirements.txt && uvicorn main:app --reload`
5. **Mobile App:** `cd mobile_app && flutter run`
