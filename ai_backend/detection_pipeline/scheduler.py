"""
Medication Scheduler — Dynamic multi-user pipeline management.

Architecture:
  - Checks medication schedules every 60 seconds for ALL users in the database
  - Dynamically spawns per-user AI detection pipelines when medication windows open
  - Looks up each user's camera_stream_url from MongoDB (falls back to CAMERA_SOURCE env)
  - Tears down pipelines when sessions expire or all meds are verified
  - Supports concurrent pipelines for multiple users simultaneously
"""

import asyncio
import os
import threading
from datetime import datetime, timedelta, timezone
from bson import ObjectId
from database import get_db
from ai.pipeline import MedicationDetectionPipeline

# Optional GoPro auto-control via Open GoPro API
_gopro_session = None


def _get_default_camera_source():
    """Read CAMERA_SOURCE from env as a fallback. Returns int index or string path."""
    raw = os.environ.get("CAMERA_SOURCE", "0")
    try:
        return int(raw)
    except ValueError:
        return raw  # could be a video file path or RTSP URL

# ─── Scheduler State ─────────────────────────────────────────────────────────

_scheduler_running = False
_active_sessions = {}   # user_id -> VerificationSession (concurrent per user)

# ── Multi-Pipeline State ─────────────────────────────────────────────────────
# Each user gets their own pipeline instance + thread, keyed by user_id
_pipelines = {}          # user_id -> MedicationDetectionPipeline
_pipeline_threads = {}   # user_id -> threading.Thread


async def _get_camera_url_for_user(user_id):
    """
    Look up a user's camera_stream_url from MongoDB.
    Falls back to CAMERA_SOURCE env var if not set.
    Uses async motor db to avoid blocking the main thread.
    """
    try:
        db = get_db()
        if db is not None:
            user = await db.users.find_one({"_id": ObjectId(user_id)}, {"camera_stream_url": 1})
            if user and user.get("camera_stream_url"):
                return user["camera_stream_url"]
    except Exception as e:
        print(f"[Scheduler] Could not look up camera for user {user_id}: {e}")
    
    # Default to the user's dedicated live stream
    return f"rtsp://127.0.0.1:8554/live/{user_id}"


def _spawn_pipeline_for_user(user_id, camera_url):
    """
    Create a new MedicationDetectionPipeline for a specific user and start
    it in a background thread connected to their camera stream.
    """
    global _pipelines, _pipeline_threads
    
    # Guard: check if the thread is still alive (covers reconnect sleep windows
    # where is_running is transiently False). Thread.is_alive() is the only
    # reliable signal — it stays True during the 10s reconnect sleep.
    existing_thread = _pipeline_threads.get(user_id)
    if existing_thread and existing_thread.is_alive():
        return _pipelines.get(user_id)
    
    pipeline = MedicationDetectionPipeline(
        api_base_url="http://localhost:8000",
        expected_medicine_count=0,
        user_id=user_id,
    )
    _pipelines[user_id] = pipeline
    
    def _run_pipeline():
        """Run the pipeline with auto-reconnect on stream failure."""
        import time as _time
        print(f"[Scheduler] Starting pipeline for user {user_id} on: {camera_url}")
        
        while pipeline.is_running or not getattr(pipeline, '_stop_requested', False):
            try:
                pipeline.is_running = True
                pipeline.run_on_video(
                    source=camera_url,
                    display=False,
                    scheduled_times=None,
                )
                # run_on_video returned normally (stream ended or stopped)
                if getattr(pipeline, '_stop_requested', False):
                    print(f"[Scheduler] Pipeline for user {user_id} stopped by request.")
                    break
                print(f"[Scheduler] Pipeline for user {user_id} exited. Restarting in 10s...")
            except Exception as e:
                if getattr(pipeline, '_stop_requested', False):
                    break
                print(f"[Scheduler] Pipeline for user {user_id} crashed: {e}. Restarting in 10s...")
            
            pipeline.is_running = False
            _time.sleep(10)
        
        pipeline.is_running = False
        print(f"[Scheduler] Pipeline thread for user {user_id} ended.")
    
    thread = threading.Thread(target=_run_pipeline, daemon=True, name=f"pipeline-{user_id[:8]}")
    thread.start()
    _pipeline_threads[user_id] = thread
    
    return pipeline


def _stop_pipeline_for_user(user_id):
    """Stop and clean up a user's pipeline."""
    global _pipelines, _pipeline_threads
    
    if user_id in _pipelines:
        pipeline = _pipelines[user_id]
        pipeline._stop_requested = True
        pipeline.stop()
        print(f"[Scheduler] Stopping pipeline for user {user_id}")
        del _pipelines[user_id]
    
    if user_id in _pipeline_threads:
        del _pipeline_threads[user_id]


def _get_pipeline_for_user(user_id):
    """Get the pipeline instance for a user, or None."""
    return _pipelines.get(user_id)


# Keep backward-compatible register_pipeline for any external code
_legacy_pipeline = None

def register_pipeline(pipeline_instance):
    """Backward-compatible: register a single pipeline from main.py startup."""
    global _legacy_pipeline
    _legacy_pipeline = pipeline_instance
    print("[Scheduler] Legacy pipeline registered (backward compatible)")


class VerificationSession:
    """Tracks a single medication verification window."""

    def __init__(self, time_slot, medications, expected_count, is_rewatch=False):
        self.time_slot = time_slot           # "HH:MM" string
        self.medications = medications       # list of med docs from DB
        self.expected_count = expected_count  # total pills expected
        self.is_rewatch = is_rewatch         # True if triggered by user rewatch
        self.started_at = datetime.now()
        self.window_minutes = 120  # 2-hour verification window
        self.status = "verifying"            # verifying | taken | missed
        self.medicines_taken = 0
        self.pipeline_started = False
        self.camera_ever_connected = False   # True once camera feeds at least one frame

        # Compute the REAL deadline from the scheduled time, not from
        # when this session object was created.  A med at 02:30 always
        # expires at 05:30 regardless of when the scheduler picks it up.
        sh, sm = map(int, time_slot.split(":"))
        today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        self.scheduled_datetime = today.replace(hour=sh, minute=sm)
        self.window_deadline = self.scheduled_datetime + timedelta(minutes=self.window_minutes)

    @property
    def time_remaining(self):
        remaining = (self.window_deadline - datetime.now()).total_seconds()
        return max(0, remaining)

    @property
    def is_expired(self):
        return self.time_remaining <= 0

    def to_dict(self):
        return {
            "time_slot": self.time_slot,
            "medications": [
                {"id": str(m["_id"]), "name": m["name"], "dosage": m["dosage"]}
                for m in self.medications
            ],
            "expected_count": self.expected_count,
            "medicines_taken": self.medicines_taken,
            "started_at": self.started_at.isoformat(),
            "window_deadline": self.window_deadline.isoformat(),
            "time_remaining_seconds": round(self.time_remaining),
            "status": self.status,
        }


# ─── Scheduler Logic ─────────────────────────────────────────────────────────

def _get_current_time_slot():
    """Return current time as 'HH:MM' string in local timezone."""
    now = datetime.now()
    return f"{now.hour:02d}:{now.minute:02d}"


def _is_time_match(scheduled_time, current_time, tolerance_minutes=180):
    """Check if current time is within ±tolerance of scheduled time (trigger only)."""
    try:
        sh, sm = map(int, scheduled_time.split(":"))
        ch, cm = map(int, current_time.split(":"))
        sched_min = sh * 60 + sm
        curr_min = ch * 60 + cm
        diff = abs(curr_min - sched_min)
        diff = min(diff, 1440 - diff)  # midnight wrap
        return diff <= tolerance_minutes
    except (ValueError, IndexError):
        return False


async def _start_pipeline_for_session(session, user_id):
    """
    Ensure a pipeline is running for this user and update it with the
    current session's medication context.
    """
    pipeline = _get_pipeline_for_user(user_id)
    
    # Also check legacy pipeline as fallback
    if not pipeline or not pipeline.is_running:
        if _legacy_pipeline and _legacy_pipeline.is_running:
            pipeline = _legacy_pipeline
        else:
            # Need to spawn a new pipeline for this user
            camera_url = await _get_camera_url_for_user(user_id)
            pipeline = _spawn_pipeline_for_user(user_id, camera_url)
            # Give the pipeline a moment to start connecting
            await asyncio.sleep(2)

    if pipeline and pipeline.is_running:
        pipeline.medication_ids = [str(med["_id"]) for med in session.medications]
        pipeline.scheduled_time = session.time_slot
        pipeline.expected_medicine_count = session.expected_count
        # Count how many meds are ALREADY taken (have a 'taken' log in DB)
        # so we don't reset progress for already-verified medicines.
        already_taken = 0
        try:
            from pymongo import MongoClient
            sync_db = MongoClient("mongodb://localhost:27017")["locusDB"]
            today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
            today_utc = today_start.astimezone(timezone.utc).replace(tzinfo=None)
            tomorrow_utc = today_utc + timedelta(days=1)
            for med in session.medications:
                log = sync_db.medication_logs.find_one({
                    "medication_id": ObjectId(str(med["_id"])),
                    "scheduled_time": {"$gte": today_utc, "$lt": tomorrow_utc},
                    "status": "taken",
                })
                if log:
                    already_taken += 1
        except Exception as e:
            print(f"[Scheduler] Could not count taken meds: {e}")
        pipeline.medicines_taken_count = already_taken
        pipeline.medicines_detected_this_session = []
        pipeline.last_result = None  # clear stale evidence from previous session
        pipeline.force_active = True  # bypass schedule window check (rewatch/new session)
        # Reset batch analysis counter so analysis runs on the next cycle
        if hasattr(pipeline, '_batch_last_analysis'):
            pipeline._batch_last_analysis = 0
        session.pipeline_started = True
        session.medicines_taken = already_taken
        print(f"[Scheduler] OK Pipeline updated for user {user_id} session {session.time_slot} "
              f"({session.expected_count} expected, {already_taken} already taken)")
    else:
        print(f"[Scheduler] ! Pipeline not yet running for user {user_id} — "
              f"session {session.time_slot} will retry next tick")
        session.pipeline_started = False


async def _log_session_result(session):
    """Log taken/missed for each medication in the session."""
    db = get_db()
    if db is None:
        print("[Scheduler] No DB connection, cannot log results")
        return

    # Use the date the session actually started, NOT "now".
    # If a 3-hour window crosses midnight (e.g., 21:30 -> 00:30), 
    # "now" would incorrectly assign the log to the next day.
    session_date = session.started_at.replace(hour=0, minute=0, second=0, microsecond=0)

    for med in session.medications:
        med_id = str(med["_id"])
        user_id = med["user_id"]

        # Build scheduled_time as a full datetime for the session's correct day
        sh, sm = map(int, session.time_slot.split(":"))
        scheduled_dt_local = session_date.replace(hour=sh, minute=sm)
        # Convert local naive time to UTC equivalent since PyMongo defaults to UTC
        scheduled_dt = scheduled_dt_local.astimezone(timezone.utc).replace(tzinfo=None)

        # Check if log already exists (use ObjectId to match DB storage format)
        from bson import ObjectId as ObjId
        start_win = scheduled_dt - timedelta(minutes=30)
        end_win = scheduled_dt + timedelta(minutes=30)
        existing = await db.medication_logs.find_one({
            "medication_id": ObjId(med_id),
            "user_id": ObjId(str(user_id)),
            "scheduled_time": {"$gte": start_win, "$lte": end_win},
        })
        if existing:
            print(f"[Scheduler] Log already exists for {med['name']} at {session.time_slot}")
            continue

        if session.medicines_taken >= session.expected_count:
            status = "needs_verification"
        elif session.medicines_taken > 0:
            status = "needs_verification"
        else:
            # Distinguish camera-offline vs camera-on-but-no-detection
            if not getattr(session, 'camera_ever_connected', False):
                status = "camera_off"
            else:
                status = "missed"

        # "taken" is already logged in real-time by the pipeline the moment
        # all 3 phases pass — skip here to avoid duplicates with wrong confidence.
        if status == "taken":
            print(f"[Scheduler] '{med['name']}' already logged as taken by real-time pipeline.")
            continue

        from bson import ObjectId
        ts_now = datetime.utcnow()
        log_doc = {
            "user_id": ObjectId(str(user_id)),
            "medication_id": ObjectId(str(med_id)),
            "scheduled_time": scheduled_dt,
            "status": status,
            "verification_method": None,
            "confidence_score": None,   # never carry pipeline confidence into missed/skipped
            "keyframe_id": None,
            "taken_at": None,
            "notes": (
                "Camera was offline during the entire scheduled window. Could not verify."
                if status in ("camera_off", "skipped")
                else "No medication intake detected within 3-hour window"
            ),
            "created_at": ts_now,
            "updated_at": ts_now,
        }

        await db.medication_logs.insert_one(log_doc)
        print(f"[Scheduler] Logged '{status}' for {med['name']} at {session.time_slot}")


async def _backfill_expired_slots():
    """
    Retroactive sweep: find any medication time slots whose 3-hour window
    has fully elapsed without a log entry and auto-log them as 'skipped'.

    Checks BOTH today AND yesterday to catch slots that expired while
    the server was offline overnight.

    Now queries ALL active medications (multi-user) instead of filtering by USER_ID.
    """
    db = get_db()
    if db is None:
        return

    now = datetime.now()

    # Query ALL active medications for ALL users
    query = {"is_active": True}
    meds_cursor = db.medications.find(query)
    all_meds = await meds_cursor.to_list(length=500)

    # Check both yesterday and today
    for day_offset in [1, 0]:  # 1 = yesterday, 0 = today
        check_date = now - timedelta(days=day_offset)
        day_start = check_date.replace(hour=0, minute=0, second=0, microsecond=0)
        day_of_week = check_date.weekday()

        for med in all_meds:
            freq = med.get("frequency", "daily")
            if freq == "weekly":
                days = med.get("days_of_week", [])
                if days and day_of_week not in days:
                    continue

            for sched_time in med.get("scheduled_times", []):
                
                # IMPORTANT: DO NOT backfill slots that occurred BEFORE the user created this medication!
                start_date = med.get("start_date") or med.get("createdAt")
                if start_date:
                    try:
                        # If start_date is already a datetime object (from motor)
                        if isinstance(start_date, datetime):
                            pass # already a datetime
                        else:
                            # It's a string
                            if start_date.endswith('Z'):
                                start_date = start_date[:-1] + '+00:00'
                            start_date = datetime.fromisoformat(start_date)
                            
                        # Ensure the datetime is timezone aware (defaulting to UTC if none is provided)
                        if start_date.tzinfo is None:
                            start_date = start_date.replace(tzinfo=timezone.utc)
                        # Check if the start of the day we're processing is BEFORE the medication's start date
                        if day_start.replace(tzinfo=timezone.utc) < start_date.replace(hour=0, minute=0, second=0, microsecond=0):
                            continue # Skip this medication for this historical day
                    except Exception as e:
                        print(f"Error parsing start_date {start_date} for med {med.get('_id')}: {e}")
                        
                try:
                    sh, sm = map(int, sched_time.split(":"))
                except (ValueError, IndexError):
                    continue

                # Build the scheduled datetime and its window end
                scheduled_dt_local = day_start.replace(hour=sh, minute=sm)
                window_end = scheduled_dt_local + timedelta(hours=3)

                # Only process slots whose window has FULLY expired
                if now < window_end:
                    continue  # window still open — leave it alone

                # Skip if there's already a session actively handling this slot
                # Also skip if this specific medicine is in ANY active session (e.g., rewatch)
                med_id_str = str(med["_id"])
                if day_offset == 0:
                    slot_active = any(s.time_slot == sched_time for s in _active_sessions.values())
                    med_in_session = any(
                        med_id_str in {str(m["_id"]) for m in s.medications}
                        for s in _active_sessions.values()
                    )
                    if slot_active or med_in_session:
                        continue

                # Convert to UTC for DB query
                scheduled_dt = scheduled_dt_local.astimezone(timezone.utc).replace(tzinfo=None)

                # Do not backfill if the scheduled time is before the medication was created/started
                med_start = med.get("start_date") or med.get("createdAt")
                if med_start and scheduled_dt.replace(tzinfo=None) < med_start.replace(tzinfo=None):
                    continue

                # Check if already logged
                start_win = scheduled_dt - timedelta(minutes=30)
                end_win = scheduled_dt + timedelta(minutes=30)
                existing = await db.medication_logs.find_one({
                    "medication_id": ObjectId(str(med["_id"])),
                    "user_id": ObjectId(str(med["user_id"])),
                    "scheduled_time": {"$gte": start_win, "$lte": end_win},
                })
                if existing:
                    continue  # already handled

                # No log exists and window has expired -> mark as camera_off
                ts_now = datetime.utcnow()
                log_doc = {
                    "user_id": ObjectId(str(med["user_id"])),
                    "medication_id": ObjectId(str(med["_id"])),
                    "scheduled_time": scheduled_dt,
                    "status": "camera_off",
                    "verification_method": None,
                    "confidence_score": None,
                    "keyframe_id": None,
                    "taken_at": None,
                    "notes": "Camera was offline during the entire scheduled window. Could not verify.",
                    "created_at": ts_now,
                    "updated_at": ts_now,
                }
                await db.medication_logs.insert_one(log_doc)
                day_label = "yesterday" if day_offset == 1 else "today"
                print(f"[Scheduler] [Backfill] Auto-logged 'camera_off' for {med['name']} at {sched_time} {day_label} "
                      f"(window ended at {window_end.strftime('%H:%M')})")


async def _ensure_stream_pipelines():
    """
    Discover active camera streams on MediaMTX and spawn/stop pipelines
    accordingly, independent of medication schedule.
    """
    import httpx
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get("http://127.0.0.1:9997/v3/paths/list", timeout=3)
        items = resp.json().get("items", [])
    except Exception:
        return  # mediamtx API not reachable — skip this tick

    # Extract user IDs from active stream paths (pattern: live/{user_id})
    streaming_user_ids = set()
    for path_info in items:
        name = path_info.get("name", "")
        if name.startswith("live/"):
            uid = name.split("live/", 1)[1]
            if uid:
                streaming_user_ids.add(uid)

    # Spawn pipelines for newly-streaming users
    for uid in streaming_user_ids:
        existing_thread = _pipeline_threads.get(uid)
        if existing_thread and existing_thread.is_alive():
            # Reset grace timer — stream is still active
            pipeline = _pipelines.get(uid)
            if pipeline and hasattr(pipeline, '_stream_gone_since'):
                pipeline._stream_gone_since = None
            continue
        camera_url = f"rtsp://127.0.0.1:8554/live/{uid}"
        _spawn_pipeline_for_user(uid, camera_url)
        print(f"[Scheduler] Stream detected for {uid[:8]}… — pipeline started")

    # Stop pipelines whose stream has been gone for >30s
    for uid in list(_pipelines.keys()):
        if uid not in streaming_user_ids:
            pipeline = _pipelines[uid]
            if not hasattr(pipeline, '_stream_gone_since') or pipeline._stream_gone_since is None:
                pipeline._stream_gone_since = datetime.now()
            elif (datetime.now() - pipeline._stream_gone_since).total_seconds() > 30:
                _stop_pipeline_for_user(uid)
                print(f"[Scheduler] Stream gone for {uid[:8]}… >30s — pipeline stopped")


async def _check_schedules():
    """Main scheduler tick — check if any medication is due now (all users)."""
    global _active_sessions

    # Ensure pipelines are running for all active camera streams
    await _ensure_stream_pipelines()

    db = get_db()
    if db is None:
        return

    current_time = _get_current_time_slot()

    # ── Retroactive backfill: catch any expired, unlogged slots ────────
    try:
        await _backfill_expired_slots()
    except Exception as e:
        print(f"[Scheduler] Backfill error: {e}")

    # ── Handle ALL active sessions (one per user) ─────────────────────
    expired_users = []
    for user_id, session in list(_active_sessions.items()):
        # Update taken count from pipeline for THIS user
        pipeline = _get_pipeline_for_user(user_id) or _legacy_pipeline
        if pipeline and pipeline.medication_ids:
            session_med_ids = set(str(m["_id"]) for m in session.medications)
            pipeline_med_ids = set(pipeline.medication_ids)
            if session_med_ids & pipeline_med_ids:  # overlap = this session owns the pipeline
                session.medicines_taken = max(session.medicines_taken, pipeline.medicines_taken_count)
                if getattr(pipeline, 'camera_online', False):
                    session.camera_ever_connected = True

        # Check if window expired
        if session.is_expired:
            print(f"[Scheduler] Verification window expired for user {user_id} at {session.time_slot}")

            pipeline = _get_pipeline_for_user(user_id) or _legacy_pipeline
            if pipeline:
                if session.medicines_taken >= session.expected_count:
                    session.status = "needs_verification"
                elif session.medicines_taken > 0:
                    session.status = "needs_verification"
                else:
                    if not getattr(session, 'camera_ever_connected', False):
                        session.status = "camera_off"
                    else:
                        session.status = "missed"
            else:
                session.status = "camera_off"

            await _log_session_result(session)
            print(f"[Scheduler] Session ended for user {user_id}: {session.status} "
                  f"({session.medicines_taken}/{session.expected_count} pills)")
            expired_users.append(user_id)

        # Check if all meds taken early
        elif (session.medicines_taken >= session.expected_count
              and session.expected_count > 0):
            print(f"[Scheduler] All {session.expected_count} medicines detected for user {user_id}! Awaiting caregiver review.")
            session.status = "needs_verification"
            await _log_session_result(session)
            expired_users.append(user_id)

    # Remove expired/completed sessions — clear medication context but keep
    # pipeline alive for face recognition / scene capture / future plugins.
    # Pipeline teardown is now handled by _ensure_stream_pipelines() when
    # the camera stream disappears.
    for uid in expired_users:
        del _active_sessions[uid]
        pipeline = _get_pipeline_for_user(uid)
        if pipeline:
            pipeline.scheduled_time = ""
            pipeline.medication_ids = []
            pipeline.expected_medicine_count = 0
            pipeline.medicines_taken_count = 0

    # ── Check for new medications due now (ALL users) ──────────────────
    # No USER_ID filter — discover all active medications in the system
    query = {"is_active": True}
    meds_cursor = db.medications.find(query)
    all_meds = await meds_cursor.to_list(length=500)

    # Group meds by (user_id, time_slot) — different users get separate sessions
    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_of_week = now.weekday()

    # Dict: (user_id_str, time_slot) -> [med_docs]
    user_slots = {}

    for med in all_meds:
        freq = med.get("frequency", "daily")
        if freq == "weekly":
            days = med.get("days_of_week", [])
            if days and day_of_week not in days:
                continue

        for sched_time in med.get("scheduled_times", []):
            if _is_time_match(sched_time, current_time):
                sh, sm = map(int, sched_time.split(":"))
                scheduled_dt_local = today_start.replace(hour=sh, minute=sm)
                scheduled_dt = scheduled_dt_local.astimezone(timezone.utc).replace(tzinfo=None)

                start_win = scheduled_dt - timedelta(minutes=30)
                end_win = scheduled_dt + timedelta(minutes=30)
                existing = await db.medication_logs.find_one({
                    "medication_id": ObjectId(str(med["_id"])),
                    "user_id": ObjectId(str(med["user_id"])),
                    "scheduled_time": {"$gte": start_win, "$lte": end_win},
                })

                # Only skip if there's a FINAL status log (taken, missed, skipped).
                # needs_verification and scheduled logs still need pipeline monitoring.
                if existing and existing.get("status") not in ("needs_verification", "scheduled"):
                    continue

                uid = str(med["user_id"])
                key = (uid, sched_time)
                if key not in user_slots:
                    user_slots[key] = []
                user_slots[key].append(med)

    # Create sessions for any new (user, time_slot) groups not already active
    for (uid, time_slot), due_meds in sorted(user_slots.items(), key=lambda x: x[0][1]):
        if uid in _active_sessions:
            existing = _active_sessions[uid]
            # Instead of ignoring different time slots, we add them to the session's monitoring
            existing_ids = {str(m["_id"]) for m in existing.medications}
            
            # Update existing medications in case they changed
            for i, m in enumerate(existing.medications):
                for due_m in due_meds:
                    if str(m["_id"]) == str(due_m["_id"]):
                        existing.medications[i] = due_m
            
            # Add any new medications
            new_meds = [m for m in due_meds if str(m["_id"]) not in existing_ids]
            if new_meds:
                existing.medications.extend(new_meds)
                existing.expected_count += len(new_meds)
                
            # If this is a new time slot, append it so the pipeline watches it
            if time_slot not in existing.time_slot.split(","):
                # if existing was just "05:00" and due is "03:50", make it "05:00,03:50"
                # If they changed the only med from 05:00 to 03:50, we just append it for safety
                existing.time_slot += f",{time_slot}"
                
                # Extend the session deadline if this time slot ends later
                sh, sm = map(int, time_slot.split(":"))
                today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                new_dt = today.replace(hour=sh, minute=sm) + timedelta(minutes=existing.window_minutes)
                if new_dt > existing.window_deadline:
                    existing.window_deadline = new_dt
                    
            # Always sync pipeline to make sure any time/med changes take effect immediately
            print(f"[Scheduler] Syncing session for {uid}: times [{existing.time_slot}], meds: {existing.expected_count}")
            pipeline = _get_pipeline_for_user(uid)
            if pipeline and pipeline.is_running:
                await _start_pipeline_for_session(existing, uid)
                
            continue

        expected_count = len(due_meds)
        session = VerificationSession(time_slot, due_meds, expected_count)
        _active_sessions[uid] = session

        print(f"\n[Scheduler] =======================================")
        print(f"[Scheduler] Medication time! {time_slot}")
        print(f"[Scheduler] User: {uid}")
        print(f"[Scheduler] {expected_count} medications due:")
        for m in due_meds:
            print(f"[Scheduler]   • {m['name']} ({m['dosage']})")
        print(f"[Scheduler] Active sessions: {len(_active_sessions)} user(s)")
        print(f"[Scheduler] Starting 2-hour verification window...")
        print(f"[Scheduler] =======================================\n")

        # Spawn a pipeline for this user and point it at the session
        await _start_pipeline_for_session(session, uid)


# ─── Scheduler Runner ─────────────────────────────────────────────────────────

async def run_scheduler():
    """Run the medication scheduler loop — checks every 60 seconds."""
    global _scheduler_running
    _scheduler_running = True
    print("[Scheduler] Multi-user medication scheduler started (checking every 60s)")

    while _scheduler_running:
        try:
            await _check_schedules()
        except Exception as e:
            print(f"[Scheduler] Error: {e}")
        await asyncio.sleep(60)


def stop_scheduler():
    """Stop the scheduler loop and all running pipelines."""
    global _scheduler_running
    _scheduler_running = False
    
    # Stop all active pipelines
    for uid in list(_pipelines.keys()):
        _stop_pipeline_for_user(uid)
    
    print("[Scheduler] Stopped (all pipelines shut down)")


# ─── Public API for routes ────────────────────────────────────────────────────

def get_active_session():
    """Return the current active sessions info, or None."""
    if _active_sessions:
        # Return the first active session (for backward compatibility)
        first_uid = next(iter(_active_sessions))
        return _active_sessions[first_uid].to_dict()
    return None


def get_scheduler_status():
    """Return scheduler state for the dashboard."""
    sessions_list = [
        {"user_id": uid, **s.to_dict()}
        for uid, s in _active_sessions.items()
    ]
    
    # Pipeline status per user
    pipeline_statuses = {
        uid: {"is_running": p.is_running, "camera_online": getattr(p, 'camera_online', False)}
        for uid, p in _pipelines.items()
    }
    
    return {
        "scheduler_running": _scheduler_running,
        "has_active_session": len(_active_sessions) > 0,
        "active_sessions": sessions_list,
        "active_session_count": len(_active_sessions),
        "active_pipeline_count": sum(1 for p in _pipelines.values() if p.is_running),
        "pipelines": pipeline_statuses,
        # Backward compatible
        "pipeline_running": any(p.is_running for p in _pipelines.values()) if _pipelines else (
            _legacy_pipeline.is_running if _legacy_pipeline else False
        ),
    }


async def rewatch_medication(medication_id, user_id, scheduled_time):
    """
    Re-start watching for a medication that was manually marked as 'not taken'.
    
    1. Deletes the old log entry so a fresh one can be created
    2. Creates a new 3-hour VerificationSession
    3. Spawns/updates a pipeline for this user's camera
    
    Called from the /api/detection/rewatch route when the PATCH endpoint
    in the Node.js backend marks a needs_verification log as missed.
    """
    global _active_sessions
    
    db = get_db()
    if db is None:
        return {"error": "No database connection"}
    
    # Look up the medication from DB
    med = await db.medications.find_one({"_id": ObjectId(medication_id)})
    if not med:
        return {"error": f"Medication {medication_id} not found"}
    
    # Parse scheduled time (HH:MM)
    time_slot = scheduled_time
    if "T" in time_slot:
        # Handle full datetime strings like "2026-05-08T16:30"
        time_slot = time_slot.split("T")[1][:5]
    
    uid = str(user_id)
    
    # Check if there's an existing session for this user
    if uid in _active_sessions:
        old = _active_sessions[uid]
        if old.time_slot == time_slot:
            # Same time slot — MERGE the rewatch medicine into the existing session
            existing_ids = {str(m["_id"]) for m in old.medications}
            if str(med["_id"]) not in existing_ids:
                old.medications.append(med)
                old.expected_count += 1
                old.is_rewatch = True  # protect from scheduler override
                print(f"[Scheduler] Merged rewatch '{med['name']}' into existing {time_slot} session "
                      f"(now {old.expected_count} medicines)")
            else:
                # Already in session — don't reset taken count, it would
                # undo already-verified medicines.  The pipeline restart
                # below will recalculate from DB.
                old.is_rewatch = True
                print(f"[Scheduler] Medicine '{med['name']}' already in {time_slot} session, restarting pipeline")
            
            # Delete old log and restart pipeline for the merged session
            try:
                today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
                today_start_utc = today_start.astimezone(timezone.utc).replace(tzinfo=None)
                tomorrow_start_utc = today_start_utc + timedelta(days=1)
                del_result = await db.medication_logs.delete_many({
                    "medication_id": ObjectId(medication_id),
                    "user_id": ObjectId(uid),
                    "scheduled_time": {"$gte": today_start_utc, "$lt": tomorrow_start_utc},
                })
                if del_result.deleted_count > 0:
                    print(f"[Scheduler] Deleted {del_result.deleted_count} old log(s) for {med['name']}")
            except Exception as e:
                print(f"[Scheduler] Could not delete old log: {e}")
            
            # Update pipeline with merged session
            await _start_pipeline_for_session(old, uid)
            
            return {
                "message": f"Re-watching {med['name']} at {time_slot} (merged with existing session)",
                "session": old.to_dict(),
            }
        else:
            # Different time slot — replace the old session
            print(f"[Scheduler] Replacing old session {old.time_slot} with rewatch {time_slot}")
            del _active_sessions[uid]
    
    # Delete the old log so a fresh one can be created by the pipeline
    try:
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        today_start_utc = today_start.astimezone(timezone.utc).replace(tzinfo=None)
        tomorrow_start_utc = today_start_utc + timedelta(days=1)
        
        del_result = await db.medication_logs.delete_many({
            "medication_id": ObjectId(medication_id),
            "user_id": ObjectId(uid),
            "scheduled_time": {"$gte": today_start_utc, "$lt": tomorrow_start_utc},
        })
        if del_result.deleted_count > 0:
            print(f"[Scheduler] Deleted {del_result.deleted_count} old log(s) for {med['name']} today")
    except Exception as e:
        print(f"[Scheduler] Could not delete old log: {e}")
    
    # Create a new verification session (rewatch = protected from scheduler override)
    session = VerificationSession(time_slot, [med], 1, is_rewatch=True)
    _active_sessions[uid] = session
    
    print(f"\n[Scheduler] =======================================")
    print(f"[Scheduler] RE-WATCH: {med['name']} ({med['dosage']})")
    print(f"[Scheduler] User: {uid}")
    print(f"[Scheduler] Time slot: {time_slot}")
    print(f"[Scheduler] New 3-hour window started")
    print(f"[Scheduler] =======================================\n")
    
    # Spawn/update pipeline for this user
    await _start_pipeline_for_session(session, uid)
    
    return {
        "message": f"Re-watching {med['name']} at {time_slot}",
        "session": session.to_dict(),
    }
