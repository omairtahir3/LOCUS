"""
Medication Scheduler — Background service that:
1. Checks medication schedules every 60 seconds
2. Auto-launches AI detection pipeline at scheduled times
3. Monitors for 10-minute verification window
4. Logs taken/missed status after window closes
"""

import asyncio
import os
import threading
from datetime import datetime, timedelta
from bson import ObjectId
from database import get_db
from ai.pipeline import MedicationDetectionPipeline

# Optional GoPro auto-control via Open GoPro API
_gopro_session = None


def _get_camera_source():
    """Read CAMERA_SOURCE from env. Returns int index or string path."""
    raw = os.environ.get("CAMERA_SOURCE", "0")
    try:
        return int(raw)
    except ValueError:
        return raw  # could be a video file path or RTSP URL

# ─── Scheduler State ─────────────────────────────────────────────────────────

_scheduler_running = False
_active_session = None   # Current verification session
_pipeline = None         # Set by register_pipeline() from main.py startup
_pipeline_thread = None


def register_pipeline(pipeline_instance):
    """Called from main.py after the always-on pipeline starts."""
    global _pipeline
    _pipeline = pipeline_instance
    print("[Scheduler] Always-on pipeline registered")


class VerificationSession:
    """Tracks a single medication verification window."""

    def __init__(self, time_slot, medications, expected_count):
        self.time_slot = time_slot           # "HH:MM" string
        self.medications = medications       # list of med docs from DB
        self.expected_count = expected_count  # total pills expected
        self.started_at = datetime.now()
        self.window_minutes = 180  # 3-hour verification window
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


def _start_pipeline_for_session(session):
    """
    Update the always-on pipeline with the current session's medication context.
    The pipeline is already running 24/7 from main.py startup.
    We just tell it which medications to log when it detects an intake.
    """
    global _pipeline

    if _pipeline and _pipeline.is_running:
        _pipeline.medication_ids = [str(med["_id"]) for med in session.medications]
        _pipeline.scheduled_time = session.time_slot
        _pipeline.expected_medicine_count = session.expected_count
        _pipeline.medicines_taken_count = 0
        _pipeline.medicines_detected_this_session = []
        session.pipeline_started = True
        print(f"[Scheduler] ✓ Pipeline updated for session {session.time_slot} "
              f"({session.expected_count} medicines expected) — watching 24/7")
    else:
        print(f"[Scheduler] ⚠ Pipeline not running — session {session.time_slot} will self-log when pipeline starts")
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
        local_offset = datetime.now().replace(microsecond=0) - datetime.utcnow().replace(microsecond=0)
        scheduled_dt = scheduled_dt_local - local_offset

        # Check if log already exists (use ObjectId to match DB storage format)
        from bson import ObjectId as ObjId
        existing = await db.medication_logs.find_one({
            "medication_id": ObjId(med_id),
            "user_id": ObjId(str(user_id)),
            "scheduled_time": scheduled_dt,
        })
        if existing:
            print(f"[Scheduler] Log already exists for {med['name']} at {session.time_slot}")
            continue

        if session.medicines_taken >= session.expected_count:
            status = "taken"
        elif session.medicines_taken > 0:
            status = "needs_verification"
        else:
            # Distinguish camera-offline vs camera-on-but-no-detection
            if not getattr(session, 'camera_ever_connected', False):
                status = "skipped"
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
                if status == "skipped"
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

    Example: if a med is scheduled at 21:00 yesterday, its window ends at 00:00.
    If the server starts at 01:00 today and no log exists, create a 'skipped' log.
    """
    db = get_db()
    if db is None:
        return

    now = datetime.now()
    local_offset = datetime.now().replace(microsecond=0) - datetime.utcnow().replace(microsecond=0)

    meds_cursor = db.medications.find({"is_active": True})
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
                if _active_session and _active_session.time_slot == sched_time and day_offset == 0:
                    continue

                # Convert to UTC for DB query
                scheduled_dt = scheduled_dt_local - local_offset

                # Check if already logged
                existing = await db.medication_logs.find_one({
                    "medication_id": ObjectId(str(med["_id"])),
                    "user_id": ObjectId(str(med["user_id"])),
                    "scheduled_time": scheduled_dt,
                })
                if existing:
                    continue  # already handled

                # No log exists and window has expired → mark as skipped
                ts_now = datetime.utcnow()
                log_doc = {
                    "user_id": ObjectId(str(med["user_id"])),
                    "medication_id": ObjectId(str(med["_id"])),
                    "scheduled_time": scheduled_dt,
                    "status": "skipped",
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
                print(f"[Scheduler] [Backfill] Auto-logged 'skipped' for {med['name']} at {sched_time} {day_label} "
                      f"(window ended at {window_end.strftime('%H:%M')})")


async def _check_schedules():
    """Main scheduler tick — check if any medication is due now."""
    global _active_session, _pipeline

    db = get_db()
    if db is None:
        return

    current_time = _get_current_time_slot()

    # ── Retroactive backfill: catch any expired, unlogged slots ────────
    # This handles medications like 00:00 whose 3-hour window (→03:00)
    # has fully elapsed with no log — auto-marks them as 'skipped'.
    try:
        await _backfill_expired_slots()
    except Exception as e:
        print(f"[Scheduler] Backfill error: {e}")

    # ── Handle active session ──────────────────────────────────────────
    if _active_session:
        # Update taken count from pipeline
        if _pipeline:
            _active_session.medicines_taken = max(_active_session.medicines_taken, _pipeline.medicines_taken_count)
            if getattr(_pipeline, 'camera_online', False):
                _active_session.camera_ever_connected = True

        # Check if window expired
        if _active_session.is_expired:
            print(f"[Scheduler] Verification window expired for {_active_session.time_slot}")

            # Final check on pipeline results
            if _pipeline:
                _active_session.medicines_taken = max(_active_session.medicines_taken, _pipeline.medicines_taken_count)
                if _active_session.medicines_taken >= _active_session.expected_count:
                    _active_session.status = "taken"
                elif _active_session.medicines_taken > 0:
                    _active_session.status = "needs_verification"
                else:
                    if not getattr(_active_session, 'camera_ever_connected', False):
                        _active_session.status = "skipped"
                    else:
                        _active_session.status = "missed"
            else:
                _active_session.status = "skipped"  # no pipeline at all = camera never available

            # Log results
            await _log_session_result(_active_session)
            print(f"[Scheduler] Session ended: {_active_session.status} "
                  f"({_active_session.medicines_taken}/{_active_session.expected_count} pills)")

            # Stop GoPro stream if it was auto-started
            if _gopro_session:
                try:
                    _gopro_session.stop()
                    print("[Scheduler] GoPro stream stopped")
                except Exception as e:
                    print(f"[Scheduler] GoPro stop error: {e}")
                finally:
                    _gopro_session = None

            _active_session = None
            # NOTE: Do NOT set _pipeline = None here.
            # The pipeline is an always-on instance managed by main.py.
            # Nulling it would lose the reference for future sessions.

        # Check if all meds taken early
        elif (_active_session.medicines_taken >= _active_session.expected_count
              and _active_session.expected_count > 0):
            print(f"[Scheduler] All {_active_session.expected_count} medicines detected!")
            _active_session.status = "taken"

            await _log_session_result(_active_session)
            _active_session = None

        return  # Don't start new session while one is active

    # ── Check for new medication due now ────────────────────────────────
    # Get all active medications
    meds_cursor = db.medications.find({"is_active": True})
    all_meds = await meds_cursor.to_list(length=500)

    # Group meds by time slot
    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_of_week = now.weekday()  # 0=Monday, 6=Sunday

    due_meds = []
    time_slot = None

    for med in all_meds:
        freq = med.get("frequency", "daily")

        # Weekly: only show on matching day
        if freq == "weekly":
            days = med.get("days_of_week", [])
            if days and day_of_week not in days:
                continue

        # Check each scheduled time
        for sched_time in med.get("scheduled_times", []):
            if _is_time_match(sched_time, current_time):
                # If we already started building a session for a different time, ignore this one for now
                if time_slot and sched_time != time_slot:
                    continue
                
                # Check if already logged today
                sh, sm = map(int, sched_time.split(":"))
                scheduled_dt_local = today_start.replace(hour=sh, minute=sm)
                
                # Convert local naive time to UTC equivalent since PyMongo defaults to UTC
                local_offset = datetime.now().replace(microsecond=0) - datetime.utcnow().replace(microsecond=0)
                scheduled_dt = scheduled_dt_local - local_offset
                
                existing = await db.medication_logs.find_one({
                    "medication_id": ObjectId(str(med["_id"])),
                    "user_id": ObjectId(str(med["user_id"])),
                    "scheduled_time": scheduled_dt,
                })
                
                if not existing:
                    due_meds.append(med)
                    time_slot = sched_time

    if due_meds and time_slot:
        expected_count = len(due_meds)
        session = VerificationSession(time_slot, due_meds, expected_count)
        _active_session = session

        print(f"\n[Scheduler] ═══════════════════════════════════════")
        print(f"[Scheduler] Medication time! {time_slot}")
        print(f"[Scheduler] {expected_count} medications due:")
        for m in due_meds:
            print(f"[Scheduler]   • {m['name']} ({m['dosage']})")
        print(f"[Scheduler] Starting 3-hour verification window...")
        print(f"[Scheduler] ═══════════════════════════════════════\n")

        # Start the pipeline
        _start_pipeline_for_session(session)


# ─── Scheduler Runner ─────────────────────────────────────────────────────────

async def run_scheduler():
    """Run the medication scheduler loop — checks every 60 seconds."""
    global _scheduler_running
    _scheduler_running = True
    print("[Scheduler] Medication scheduler started (checking every 60s)")

    while _scheduler_running:
        try:
            await _check_schedules()
        except Exception as e:
            print(f"[Scheduler] Error: {e}")
        await asyncio.sleep(60)


def stop_scheduler():
    """Stop the scheduler loop."""
    global _scheduler_running
    _scheduler_running = False
    print("[Scheduler] Stopped")


# ─── Public API for routes ────────────────────────────────────────────────────

def get_active_session():
    """Return the current active session info, or None."""
    if _active_session:
        return _active_session.to_dict()
    return None


def get_scheduler_status():
    """Return scheduler state for the dashboard."""
    return {
        "scheduler_running": _scheduler_running,
        "has_active_session": _active_session is not None,
        "active_session": _active_session.to_dict() if _active_session else None,
        "pipeline_running": _pipeline.is_running if _pipeline else False,
    }

