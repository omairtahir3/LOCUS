# RTMP Connection Disconnection Fix

## Problem Summary
RTMP stream connection was disconnecting every 2 seconds with status showing "connecting" and keyframes not being stored.

## Root Causes Identified

### 1. **FFMPEG Configuration Too Restrictive (Primary Issue)**
- **stimeout**: Set to only 5 seconds - RTMP streams need more time to buffer initial frames
- **No nobuffer flag**: Stream was buffering, causing frame delays and timeouts
- **Low probesize**: 1MB insufficient for MPEG stream detection; streams were timing out during probe phase

### 2. **Aggressive Reconnection Timeout**
- Max retries: 60 attempts (5 minutes) was excessive
- Retry interval: 5 seconds was too long for responsive reconnection
- No feedback on success/failure in connection status

### 3. **Frame Reading Issues**
- `VideoSource._update()` would exit after a single failed frame read
- No handling for temporary frame buffering delays
- Timeout in `read()` was set to 1 second (1000 iterations), too short for RTMP

### 4. **No Connection State Tracking**
- When stream died, the app didn't provide clear status
- Keyframe extraction continued even when stream was dead

## Changes Made

### File: `ai_backend/keyframe_backend/keyframe.py`

#### 1. **Improved FFMPEG Configuration** (Lines ~1287-1295)
```python
# Changed from:
"rtsp_transport;tcp|analyzeduration;1000000|probesize;1000000|stimeout;5000000"

# Changed to:
"rtsp_transport;tcp|analyzeduration;2000000|probesize;2000000|stimeout;20000000|fflags;nobuffer|flags;low_delay"
```

**Key improvements:**
- `stimeout`: 5s → 20s (allows slow RTMP streams to connect)
- `probesize`: 1MB → 2MB (better stream format detection)
- `analyzeduration`: 1s → 2s (more time for codec analysis)
- `fflags;nobuffer`: Added (prevents frame buffering/delays)
- `flags;low_delay`: Added (prioritizes latency over buffering)

#### 2. **Faster Reconnection Logic** (Lines ~1306-1320)
```python
# Changed from:
max_retries = 60  # 5 minutes
self.cap = cv2.VideoCapture(self.source)  # Missing cv2.CAP_FFMPEG

# Changed to:
max_retries = 12  # 1 minute
self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG)  # Ensures FFMPEG engine
```

**Key improvements:**
- Reduced retry attempts (faster failure detection)
- Consistent use of cv2.CAP_FFMPEG backend
- Added success feedback messages

#### 3. **Robust Frame Reading** (Lines ~1363-1391)
```python
# Changed _update() to:
- Track consecutive failures (fail counter)
- Break only after 5 consecutive failures (not 1)
- Add delays between retry attempts
- Catch exceptions and log them
```

**Key improvements:**
- Handles temporary network hiccups
- Better error messages
- Connection stays alive during transient failures

#### 4. **Improved Frame Waiting** (Lines ~1427-1450)
```python
# Changed from:
timeout = 0  (counter, inefficient)
while not getattr(self, '_new_frame', False) and self._running and timeout < 1000:
    time.sleep(0.005)
    timeout += 1

# Changed to:
timeout_ms = 2000  # 2 second max wait
while not getattr(self, '_new_frame', False) and self._running and waited_ms < timeout_ms:
    time.sleep(0.005)
    waited_ms += 5
```

**Key improvements:**
- Explicit 2-second timeout for new frames
- If no frame arrives within 2s, signals stall and reconnects
- Better diagnostics when stream is stalled

### File: `ai_backend/medication_backend/ai/pipeline.py`

#### 1. **Faster Reconnection** (Lines ~1351-1370)
```python
# Changed sleep from 5s to 3s
time.sleep(3)  # Down from 5

# Added connection status feedback
print(f"[Pipeline] ✓ Reconnected to {source}")
```

#### 2. **Better Heartbeat Logging** (Lines ~1372-1377)
```python
# Added camera online status to heartbeat
print(f"[Pipeline] ✓ Heartbeat: {frame_count} frames, {fps:.1f} fps, camera_online={self.camera_online}")
```

#### 3. **Less Aggressive Idle Sleep** (Line ~1395)
```python
time.sleep(1)  # Down from 2s
```

**Impact:** When schedule window is outside meds, stream stays alive but doesn't process - reduces unnecessary computation while maintaining connection.

## How This Fixes the Problem

1. **RTMP Won't Timeout**: 20-second stimeout gives slow RTMP streams time to send data
2. **Frames Flow Immediately**: nobuffer + low_delay flags prevent buffering delays
3. **Connection Recovers Faster**: 3-second reconnect vs 5-second, and exits failed connections faster
4. **Transient Failures Handled**: Frame read loop tolerates 1-2 frame drops without disconnecting
5. **Clear Status Feedback**: Heartbeat now shows camera_online status so UI can reflect connection state

## Testing Recommendations

1. **Monitor Logs**: Look for:
   - `[VideoSource] FFMPEG options configured for RTMP/RTSP reliability` ✓
   - `[VideoSource] ✓ Stream connected on attempt X`
   - `[VideoSource] ✓ First frame received successfully`
   - `[Pipeline] ✓ Heartbeat: ...` (should appear every ~1 second)

2. **Check Keyframe Storage**: 
   - Keyframes should now accumulate in `ai_backend/keyframe_backend/keyframe_storage/`
   - Each user_id should have a `YYYY-MM-DD/` subfolder
   - Should see `.jpg` and `.json` files

3. **Monitor RTMP Connection**:
   - Connection should stay alive even when not actively detecting
   - Reconnection should happen within 3-5 seconds of disconnection
   - No more "connecting" loop every 2 seconds

4. **Database Logging**:
   - Check `medication_logs` collection for entries with:
     - `status`: "auto_verified", "needs_verification", or "taken"
     - `verification_method`: "Camera"
     - `confidence_score`: Should show detection confidence

## If Issues Persist

Check the following:

1. **RTMP Server**: Is the GoPro/RTMP source actually streaming?
   - Test with: `ffprobe rtmp://[url]`
   
2. **Firewall/NAT**: Can the server reach the RTMP source?
   - Test with: `curl -I rtmp://[url]`

3. **Logs**: Review both stdout and app logs for errors starting with `[VideoSource]` or `[Pipeline]`

4. **Frame Rate**: Current setup targets 5 FPS analysis - if source is lower, increase buffer time in scheduler

## Files Modified
- `ai_backend/keyframe_backend/keyframe.py` (VideoSource class)
- `ai_backend/medication_backend/ai/pipeline.py` (run_on_video method)
