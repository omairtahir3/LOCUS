# Fuzzy Match Warnings Report

This is a list of every single time the `despite some inaccuracies` warning appeared during a file modification across this project's history.

### Step 99 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx\mediamtx.yml`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python

```

### Step 105 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx\mediamtx.yml`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
rtspAnyPort: no
# Range header to send to the source, in order to start streaming from the specified offset.
# available values:
# * clock: Absolute time
# * npt: Normal Play Time
```

### Step 109 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx\mediamtx.yml`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
# Secured camera feeds (allows any stream under live/)
# No publish auth — GoPro Quik doesn't support RTMP auth
~^live/:
readUser: locus_ai
readPass: LocusRead2026
```

### Step 119 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx\mediamtx.yml`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
all_others:
publishUser: disable
readUser: disable
```

### Step 174 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx\mediamtx.yml`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
logLevel: debug
readTimeout: 30s
writeTimeout: 30s
writeQueueSize: 4096
```

### Step 463 - scheduler.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\scheduler.py`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python

```

### Step 958 - mediamtx.yml
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\mediamtx.yml`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
# Enable the HTTP API.
api: yes
```

### Step 1291 - keyframe.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\keyframe_backend\keyframe.py`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
import re
def _get_username_from_db(user_id):
"""
Given a MongoDB ObjectId string, fetches the user's name.
Formats the name to be a safe filesystem directory name.
```

### Step 1403 - keyframe.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\keyframe_backend\keyframe.py`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
for u_dir in user_dirs:
if not os.path.exists(u_dir): continue
for d_dir in os.scandir(u_dir):
if not d_dir.is_dir(): continue
for entry in os.scandir(d_dir.path):
```

### Step 1473 - keyframe.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\keyframe_backend\keyframe.py`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
print(f"[KeyframeStorage] Successfully saved frame to: {img_path}")
```

### Step 1733 - keyframe.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\keyframe_backend\keyframe.py`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
# Medication evidence storage lives inside keyframe_backend/medications_storage/
MEDICATION_EVIDENCE_STORAGE_DIR = os.path.join(
os.path.dirname(os.path.abspath(__file__)),
"medications_storage"
# Time-to-live for evidence: usually keep longer (e.g. 30 days)
```

### Step 1736 - routes.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\keyframe_backend\routes.py`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
from .keyframe import KeyframeStorage, KEYFRAME_STORAGE_DIR, MedicationEvidenceStorage, MEDICATION_EVIDENCE_STORAGE_DIR
_evidence_storage = MedicationEvidenceStorage(MEDICATION_EVIDENCE_STORAGE_DIR)
@router.get("/medication_frames")
async def list_medication_frames(limit: int = 100, user_id: str = ""):
@router.get("/medication_frames/{evidence_id}/image")
```

### Step 1748 - detection.js
- **File:** `c:\Users\dell\Desktop\LOCUS\web_app\backend\routes\detection.js`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
// GET /api/detection/medication_frames/:id/image — serve medication frame image (binary pipe)
router.get('/medication_frames/:id/image', async (req, res) => {
try {
const url = `${AI_BACKEND}/api/keyframes/medication_frames/${req.params.id}/image`;
const response = await axios({ method: 'get', url, responseType: 'stream', timeout: 10000 });
```

### Step 1761 - api.js
- **File:** `c:\Users\dell\Desktop\LOCUS\web_app\frontend\src\services\api.js`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
getMedicationFrames:       (params) => api.get('/detection/medication_frames', { params }),
getMedicationFrameImage:  (id) => `${API_BASE}/detection/medication_frames/${id}/image`,
```

### Step 1770 - KeyframeAudit.jsx
- **File:** `c:\Users\dell\Desktop\LOCUS\web_app\frontend\src\pages\KeyframeAudit.jsx`
- **Did the added code survive?** YES
- **Snippet of added code:**
```python
detectionAPI.getMedicationFrames(queryParams).catch(() => ({ data: [] })),
src={detectionAPI.getMedicationFrameImage(evId)}
src={detectionAPI.getMedicationFrameImage(evId)}
src={detectionAPI.getMedicationFrameImage(evId)}
```

### Step 1812 - pipeline.py
- **File:** `c:\Users\dell\Desktop\LOCUS\ai_backend\medication_backend\ai\pipeline.py`
- **Did the added code survive?** NO (Failed fuzzy match or overwritten)
- **Snippet of added code:**
```python
# Write to centralized EventLog MongoDB collection
if status == "taken":
try:
from pymongo import MongoClient
from datetime import datetime, timezone
```

