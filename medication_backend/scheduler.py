"""
Medication Scheduler — Background service that:
1. Checks medication schedules every 60 seconds
2. Auto-launches AI detection pipeline at scheduled times
3. Monitors for 10-minute verification window
4. Logs taken/missed status after window closes
"""

import asyncio
import threading
from datetime import datetime, timedelta
from database import get_db
from ai.pipeline import MedicationDetectionPipeline

# ─── Scheduler State ─────────────────────────────────────────────────────────

_scheduler_running = False
_active_session = None   # Current verification session
_pipeline = None
_pipeline_thread = None


class VerificationSession:
    """Tracks a single medication verification window."""

    def __init__(self, time_slot, medications, expected_count):
        self.time_slot = time_slot           # "HH:MM" string
        self.medications = medications       # list of med docs from DB
        self.expected_count = expected_count  # total pills expected
        self.started_at = datetime.now()
        self.window_minutes = 10
        self.status = "verifying"            # verifying | taken | missed
        self.medicines_taken = 0
        self.pipeline_started = False

    @property
    def time_remaining(self):
        elapsed = (datetime.now() - self.started_at).total_seconds()
        remaining = (self.window_minutes * 60) - elapsed
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
            "time_remaining_seconds": round(self.time_remaining),
            "status": self.status,
        }


# ─── Scheduler Logic ─────────────────────────────────────────────────────────

def _get_current_time_slot():
    """Return current time as 'HH:MM' string in local timezone."""
    now = datetime.now()
    return f"{now.hour:02d}:{now.minute:02d}"


def _is_time_match(scheduled_time, current_time, tolerance_minutes=2):
    """Check if current time is within ±tolerance of scheduled time."""
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
    """Start the AI detection pipeline for a verification session."""
    global _pipeline, _pipeline_thread

    if _pipeline and _pipeline.is_running:
        print("[Scheduler] Pipeline already running, skipping")
        return

    _pipeline = MedicationDetectionPipeline(
        api_base_url="http://localhost:5000",
        expected_medicine_count=session.expected_count
    )

    scheduled_times = [session.time_slot]

    def run():
        _pipeline.run_on_video(
            source=0,  # webcam for now, will switch to GoPro later
            display=False,
            scheduled_times=scheduled_times
        )

    _pipeline_thread = threading.Thread(target=run, daemon=True)
    _pipeline_thread.start()
    session.pipeline_started = True
    print(f"[Scheduler] Pipeline started for time slot {session.time_slot} "
          f"({session.expected_count} medicines expected)")


async def _log_session_result(session):
    """Log taken/missed for each medication in the session."""
    db = get_db()
    if db is None:
        print("[Scheduler] No DB connection, cannot log results")
        return

    now = datetime.now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    for med in session.medications:
        med_id = str(med["_id"])
        user_id = med["user_id"]

        # Build scheduled_time as a full datetime for today
        sh, sm = map(int, session.time_slot.split(":"))
        scheduled_dt_local = today_start.replace(hour=sh, minute=sm)
        # Convert local naive time to UTC equivalent since PyMongo defaults to UTC
        local_offset = datetime.now() - datetime.utcnow()
        scheduled_dt = scheduled_dt_local - local_offset

        # Check if log already exists
        existing = await db.medication_logs.find_one({
            "medication_id": med_id,
            "user_id": user_id,
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
            status = "missed"
        log_doc = {
            "user_id": user_id,
            "medication_id": med_id,
            "scheduled_time": scheduled_dt,
            "status": status,
            "verification_method": "visual" if status == "taken" else None,
            "confidence_score": None,
            "keyframe_id": None,
            "taken_at": now if status == "taken" else None,
            "notes": f"Auto-verified by AI scheduler ({session.medicines_taken} pills detected)"
                     if status == "taken" else "No medication intake detected within 10-minute window",
            "created_at": now,
            "updated_at": now,
        }

        # If pipeline has a result, grab the confidence
        if _pipeline and _pipeline.last_result:
            log_doc["confidence_score"] = _pipeline.last_result.get("final_confidence")

        await db.medication_logs.insert_one(log_doc)
        print(f"[Scheduler] Logged '{status}' for {med['name']} at {session.time_slot}")


async def _check_schedules():
    """Main scheduler tick — check if any medication is due now."""
    global _active_session, _pipeline

    db = get_db()
    if db is None:
        return

    current_time = _get_current_time_slot()

    # ── Handle active session ──────────────────────────────────────────
    if _active_session:
        # Update taken count from pipeline
        if _pipeline and _pipeline.is_running:
            _active_session.medicines_taken = _pipeline.medicines_taken_count

        # Check if window expired
        if _active_session.is_expired:
            print(f"[Scheduler] Verification window expired for {_active_session.time_slot}")

            # Final check on pipeline results
            if _pipeline:
                _active_session.medicines_taken = _pipeline.medicines_taken_count
                if _active_session.medicines_taken >= _active_session.expected_count:
                    _active_session.status = "taken"
                elif _active_session.medicines_taken > 0:
                    _active_session.status = "needs_verification"
                else:
                    _active_session.status = "missed"
                # Stop pipeline
                if _pipeline.is_running:
                    _pipeline.stop()
            else:
                _active_session.status = "missed"

            # Log results
            await _log_session_result(_active_session)
            print(f"[Scheduler] Session ended: {_active_session.status} "
                  f"({_active_session.medicines_taken}/{_active_session.expected_count} pills)")
            _active_session = None
            _pipeline = None

        # Check if all meds taken early
        elif (_active_session.medicines_taken >= _active_session.expected_count
              and _active_session.expected_count > 0):
            print(f"[Scheduler] All {_active_session.expected_count} medicines detected!")
            _active_session.status = "taken"

            # Stop pipeline early
            if _pipeline and _pipeline.is_running:
                _pipeline.stop()

            await _log_session_result(_active_session)
            _active_session = None
            _pipeline = None

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
                # Check if already logged today
                sh, sm = map(int, sched_time.split(":"))
                scheduled_dt = today_start.replace(hour=sh, minute=sm)
                existing = await db.medication_logs.find_one({
                    "medication_id": str(med["_id"]),
                    "user_id": med["user_id"],
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
        print(f"[Scheduler] Starting 10-minute verification window...")
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
