# LOCUS

LOCUS is an advanced, AI-powered health and medication monitoring ecosystem designed specifically to assist elderly individuals while providing peace of mind to their caregivers. The system leverages real-time computer vision, multi-platform applications, and robust scheduling to ensure medication adherence and overall safety.

## Key Features

* **AI Medication Verification:** Uses computer vision and Google Gemini AI to analyze live camera feeds and automatically verify when an elderly user takes their scheduled medication.
* **Caregiver Dashboard:** A dedicated portal for caregivers to review medication adherence, view AI-captured evidence frames (Keyframe Audit), and monitor the well-being of their family members.
* **Real-time Video Processing:** Integrates with MediaMTX to stream and process real-time video (RTSP/WebRTC) for continuous event detection.
* **Cross-Platform Notifications:** Synchronized notification preferences across devices, supporting Push Notifications (via FCM), Email alerts, Missed Dose warnings, and Emergency alerts.
* **Unified State Management:** Seamless synchronization of user settings, schedules, and event logs between the Mobile App and the Web App.

## Architecture & Components

The LOCUS platform is split into three main components:

### 1. Web Application (`/web_app`)
The core management interface for both users and caregivers.
* **Frontend:** Built with React and Vite. Features a responsive, accessible UI with dedicated views like the Caregiver Dashboard, Medication Schedules, and Keyframe Auditing.
* **Backend:** A Node.js and Express server powered by MongoDB. It handles authentication (JWT), scheduling, API routing, and acts as a proxy to the AI microservices.

### 2. AI Backend (`/ai_backend`)
The intelligence hub responsible for analyzing video streams and identifying events.
* **Core:** Built with Python and FastAPI.
* **Medication Pipeline:** A modular AI engine that runs OpenCV-based motion and blur detection alongside LLM-based frame analysis to confirm medication intake.
* **Media Server:** Bundled with MediaMTX to ingest and distribute live camera streams efficiently.

### 3. Mobile Application (`/mobile_app`)
A portable companion app ensuring constant connectivity.
* **Framework:** Built with Flutter.
* **Features:** Allows users and caregivers to view schedules on the go, receive instant Firebase Cloud Messaging (FCM) push notifications, and update their alert preferences.

## Getting Started

### Prerequisites
* Node.js (v18+)
* Python (3.10+)
* Flutter SDK
* MongoDB instance running locally or via Atlas
* Firebase Service Account (for mobile push notifications)

### Running the Services Locally

1. **Start the Web Backend:**
   ```bash
   cd web_app/backend
   npm install
   npm run dev
   ```
   *Runs on port 5000.*

2. **Start the Web Frontend:**
   ```bash
   cd web_app/frontend
   npm install
   npm run dev
   ```
   *Runs on port 5173.*

3. **Start the MediaMTX Server:**
   ```bash
   cd ai_backend/medication_backend/mediamtx
   ./mediamtx.exe
   ```

4. **Start the AI Backend:**
   ```bash
   cd ai_backend/medication_backend
   pip install -r requirements.txt
   uvicorn main:app --host 0.0.0.0 --port 8000 --reload
   ```
   *Runs on port 8000.*

5. **Run the Mobile App:**
   ```bash
   cd mobile_app
   flutter pub get
   flutter run
   ```

## Security & Access Control
LOCUS implements a strict Role-Based Access Control (RBAC) system. 
* **Normal Users (Elderly):** Can only view their own medication schedules and events.
* **Caregivers (Family Members):** Can monitor assigned users, audit AI keyframes, and configure alert settings on their behalf.

---
*Built to empower independent living through ambient intelligence.*
