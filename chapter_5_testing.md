# 5 Chapter 5: Testing and Evaluation

Once the system has been successfully developed, testing has to be conducted to ensure that the system works as intended. This is also to check that the system meets the requirements stated earlier. Besides that, system testing will help in finding the errors that may be hidden from the user. The testing must be completed before it is deployed for use.

There are few types of testing which include unit testing, functional testing and integration testing. You are required to perform each of these in-depth to ensure system quality.

## 5.1 Unit Testing
Unit testing verifies the smallest testable components of the software (e.g., individual functions, methods, or classes) in isolation. The purpose is to ensure that each unit performs as expected, independent of the full system.

**Unit Testing 1: `is_pill_in_hand()` Spatial and Logical Validation**
**Objective:** To ensure the AI pipeline correctly identifies when a pill is physically held in the user's hand based on bounding box overlap, size constraints, and palm proximity.

| No. | Test case/Test script | Attribute and Value | Expected Result | Actual Result |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Call `is_pill_in_hand()` with valid pill overlapping hand | Overlap IoU > 0.15, Size Ratio < 35%, YOLO Confidence > 0.40 | Validates as pill in hand (True) | True |
| 2 | Call `is_pill_in_hand()` with excessively large object | Size Ratio > 35% of hand area | Rejects as false positive (False) | False |
| 3 | Call `is_pill_in_hand()` with pill far from palm center | Distance > 80% of hand diagonal | Rejects as false positive (False) | False |
| 4 | Call `is_pill_in_hand()` with low confidence detection | YOLO Confidence = 0.25 | Rejects weak detection (False) | False |

**Unit Testing 2: `_is_time_match()` Scheduling Logic**
**Objective:** To ensure the background scheduler correctly identifies if the current time falls within the allowed tolerance window for a scheduled medication.

| No. | Test case/Test script | Attribute and Value | Expected Result | Actual Result |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Call `_is_time_match()` with exact time match | Current: 08:00, Scheduled: 08:00 | Validates time match (True) | True |
| 2 | Call `_is_time_match()` within tolerance window | Current: 09:30, Scheduled: 08:00 | Validates time match (True) | True |
| 3 | Call `_is_time_match()` outside tolerance window | Current: 12:00, Scheduled: 08:00 | Rejects time match (False) | False |
| 4 | Call `_is_time_match()` across midnight boundary | Current: 01:00, Scheduled: 23:00 | Validates time match (True) | True |

---

## 5.2 Functional Testing
Functional testing validates that the system modules work correctly as a whole, ensuring that the developed system meets its specifications and requirements.

**Functional Testing 1: 3-Phase Medication Detection via Body-Cam**
**Objective:** To verify the AI pipeline successfully identifies a complete medication intake event by strictly tracking the 3-phase temporal sequence (Pill in Hand → Hand to Mouth → Pill Gone).

| No. | Test Case | Attribute and value | Expected Result | Actual Result | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Perform complete medication intake sequence | Frames contain: P1 (Pill in hand), P2 (Hand disappears upward), P3 (Pill gone) | Sequence completes, confidence computed, event marked as taken | Event classified as taken and evidence saved | Pass |
| 2 | Perform incomplete sequence (pill picked up but not consumed) | Frames contain: P1 (Pill in hand), but no P2 or P3 | Sequence remains incomplete, buffer retains P1 for future frames | Detection ignores incomplete action | Pass |

**Functional Testing 2: Manual Rewatch Trigger Initialization**
**Objective:** To ensure users can manually re-trigger the AI surveillance pipeline for a specific medication slot that was missed or improperly logged.

| No. | Test Case | Attribute and value | Expected Result | Actual Result | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Trigger `/rewatch` API for a specific medication slot | Medication ID: 64a... | Old logs deleted, new verification session created with `is_rewatch=True`, pipeline resets | Rewatch session initialized successfully | Pass |
| 2 | Scheduler checks slots during active rewatch session | Scheduler tick runs, active rewatch session exists | Scheduler skips overriding the active rewatch session | Existing rewatch session protected | Pass |

---

## 5.3 Business Rules Testing
Decision table based testing technique is used to test business rules. The table contains conditions as inputs and actions as outputs.

**Business Rule Testing 1: Medication Window Expiration Logging**
**Objective:** To ensure the system correctly categorizes the outcome of a medication window when the 3-hour period expires based on camera connectivity and pills detected.

**Conditions:**
- **C1:** Was the camera connected during the window?
- **C2:** Are the medicines taken equal to the expected count?
- **C3:** Are the medicines taken greater than 0 but less than expected?

| No. | Conditions (C1, C2, C3) | Attribute and value | Expected Result | Actual Result | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | C1: Yes, C2: Yes, C3: N/A | Camera connected, All pills detected | Log status as `taken` | Logged as `taken` | Pass |
| 2 | C1: Yes, C2: No, C3: Yes | Camera connected, Partial pills detected | Log status as `needs_verification` | Logged as `needs_verification` | Pass |
| 3 | C1: Yes, C2: No, C3: No | Camera connected, 0 pills detected | Log status as `missed` | Logged as `missed` | Pass |
| 4 | C1: No, C2: No, C3: No | Camera offline entirely, 0 pills detected | Log status as `skipped` | Logged as `skipped` | Pass |

---

## 5.4 Integration Testing
Integration testing verifies that different modules of the system work together correctly, focusing on the interfaces, linkages, and data flow between modules.

**Integration Testing 1: Medication Scheduler to AI Pipeline Synchronization**
**Objective:** To ensure the background scheduler correctly initializes the AI pipeline with the required context and reliably retrieves detection results to update the database.

| No. | Test case/Test script | Attribute and value | Expected result | Actual result | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Create Session (Scheduler ↔ AI Pipeline) | Time slot matches schedule, Expected Count: 2 | Pipeline `expected_medicine_count` updated, previous buffer cleared | Pipeline initialized with correct med data | Pass |
| 2 | Pipeline Detection to DB (AI Pipeline ↔ Scheduler ↔ DB) | AI pipeline detects intake, updates `medicines_taken_count` | Scheduler reads updated count, matches expected, logs `taken` to Database | DB updated automatically successfully | Pass |

**Integration Testing 2: Evidence Frame Storage and Proxy API Data Flow**
**Objective:** To ensure keyframes captured by the Python AI are correctly stored and successfully fetched by the React Frontend via the Node.js proxy server.

| No. | Test case/Test script | Attribute and value | Expected result | Actual result | Result |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | Save Evidence (AI Pipeline ↔ File System) | Pipeline completes 3-phase intake | 3 distinct evidence images saved to `evidence_storage` with phase labels | Images stored on disk successfully | Pass |
| 2 | Fetch Evidence (React UI ↔ Node.js API ↔ Python API) | Frontend requests evidence carousel | Node.js proxies request, Python returns base64 images | Frontend renders the P1, P2, P3 images | Pass |
