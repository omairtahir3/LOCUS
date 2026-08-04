from fastapi import APIRouter, HTTPException, Depends, Query
from pydantic import BaseModel
from database import get_db
from schemas.medication import (
    MedicationCreate, MedicationUpdate, MedicationResponse,
    MedicationLogCreate, MedicationLogUpdate, MedicationLogResponse,
    DailyAdherenceSummary, MedicationScheduleItem, DoseStatus
)
from models.medication import medication_document, medication_log_document, serialize_doc, serialize_docs
from utils.auth import get_current_user
from bson import ObjectId
from datetime import datetime, date, timedelta
from typing import List, Optional

router = APIRouter(prefix="/api/medications", tags=["Medications"])


async def _resolve_target_user(user_id: Optional[str], current_user: dict, db) -> str:
    """
    Resolve the target user ID for cross-user queries.
    If user_id is provided and differs from current user, verify caregiver access.
    Returns the target user_id string to query against.
    """
    if not user_id or user_id == current_user["id"]:
        return current_user["id"]

    # Verify the current user is a caregiver/admin with access to this user
    role = current_user.get("role", "user")
    if role not in ["caregiver", "admin"]:
        raise HTTPException(status_code=403, detail="Access denied")

    if role == "caregiver":
        caregiver = await db.users.find_one({"_id": ObjectId(current_user["id"])})
        if not caregiver:
            raise HTTPException(status_code=404, detail="Caregiver not found")
        monitoring_ids = [str(mid) for mid in caregiver.get("monitoring_users", [])]
        if user_id not in monitoring_ids:
            raise HTTPException(status_code=403, detail="You do not have access to this user's data")

    return user_id


# ─── Medication CRUD ──────────────────────────────────────────────────────────

@router.post("", response_model=MedicationResponse, status_code=201)
async def create_medication(
    data: MedicationCreate,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Add a new medication to the user's schedule."""
    doc = medication_document(current_user["id"], data.model_dump())
    result = await db.medications.insert_one(doc)
    created = await db.medications.find_one({"_id": result.inserted_id})
    return serialize_doc(created)


@router.get("", response_model=List[MedicationResponse])
async def get_medications(
    active_only: bool = True,
    user_id: Optional[str] = Query(default=None, alias="user_id"),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Get all medications for the current user or a monitored user (caregiver access)."""
    target_id = await _resolve_target_user(user_id, current_user, db)
    query = {"user_id": target_id}
    if active_only:
        query["is_active"] = True
    cursor = db.medications.find(query).sort("created_at", -1)
    return serialize_docs(await cursor.to_list(length=100))


@router.get("/{medication_id}", response_model=MedicationResponse)
async def get_medication(
    medication_id: str,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Get a single medication by ID."""
    med = await db.medications.find_one({
        "_id": ObjectId(medication_id),
        "user_id": current_user["id"]
    })
    if not med:
        raise HTTPException(status_code=404, detail="Medication not found")
    return serialize_doc(med)


@router.put("/{medication_id}", response_model=MedicationResponse)
async def update_medication(
    medication_id: str,
    data: MedicationUpdate,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Update a medication's details."""
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    update_data["updated_at"] = datetime.utcnow()

    result = await db.medications.update_one(
        {"_id": ObjectId(medication_id), "user_id": current_user["id"]},
        {"$set": update_data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Medication not found")

    updated = await db.medications.find_one({"_id": ObjectId(medication_id)})
    return serialize_doc(updated)


@router.delete("/{medication_id}", status_code=204)
async def delete_medication(
    medication_id: str,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Soft delete — marks medication as inactive instead of removing it."""
    result = await db.medications.update_one(
        {"_id": ObjectId(medication_id), "user_id": current_user["id"]},
        {"$set": {"is_active": False, "updated_at": datetime.utcnow()}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Medication not found")


# ─── Today's Schedule ─────────────────────────────────────────────────────────

@router.get("/schedule/today", response_model=List[MedicationScheduleItem])
async def get_todays_schedule(
    user_id: Optional[str] = Query(default=None, alias="user_id"),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Returns today's medication schedule for the user.
    Caregivers can pass ?user_id=<id> to view a monitored user's schedule.
    Handles daily/weekly frequency:
    - daily: always shown
    - weekly: only shown if today's day-of-week matches days_of_week
    - as_needed: always shown
    """
    target_id = await _resolve_target_user(user_id, current_user, db)

    today = date.today()
    today_start_naive = datetime(today.year, today.month, today.day, 0, 0, 0)
    today_end_naive   = datetime(today.year, today.month, today.day, 23, 59, 59)
    today_start = datetime.utcfromtimestamp(today_start_naive.timestamp())
    today_end   = datetime.utcfromtimestamp(today_end_naive.timestamp())
    day_of_week = today.weekday()  # 0=Monday, 6=Sunday

    # Fetch all active medications for the target user
    meds_cursor = db.medications.find({"user_id": target_id, "is_active": True})
    meds = await meds_cursor.to_list(length=100)

    # Fetch today's logs
    from bson import ObjectId
    logs_cursor = db.medication_logs.find({
        "user_id": ObjectId(target_id) if isinstance(target_id, str) else target_id,
        "scheduled_time": {"$gte": today_start, "$lte": today_end}
    })
    logs = await logs_cursor.to_list(length=200)
    
    from datetime import timezone
    def get_local_hm(dt):
        return datetime.fromtimestamp(dt.replace(tzinfo=timezone.utc).timestamp()).strftime('%H:%M')
        
    log_map = {f"{l['medication_id']}_{get_local_hm(l['scheduled_time'])}": l for l in logs}

    schedule = []
    for med in meds:
        freq = med.get("frequency", "daily")

        # Weekly: only show on matching day
        if freq == "weekly":
            days = med.get("days_of_week", [])
            if days and day_of_week not in days:
                continue

        for time_str in med.get("scheduled_times", []):
            key = f"{str(med['_id'])}_{time_str}"
            log = log_map.get(key)
            status = DoseStatus(log["status"]) if log else DoseStatus.scheduled
            schedule.append(MedicationScheduleItem(
                id=str(log["_id"]) if log else None,
                medication_id=str(med["_id"]),
                medication_name=med["name"],
                dosage=med["dosage"],
                scheduled_time=time_str,
                status=status,
                instructions=med.get("instructions"),
                snooze_duration_minutes=med.get("snooze_duration_minutes", 10)
            ))

    # Sort by scheduled time
    schedule.sort(key=lambda x: x.scheduled_time)
    return schedule


# ─── Medication Logs ──────────────────────────────────────────────────────────

@router.post("/logs/", response_model=MedicationLogResponse, status_code=201)
async def create_log(
    data: MedicationLogCreate,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Log a medication dose event.
    Called when user takes, misses, snoozes, or skips a dose.
    Also called by the camera module when visual detection occurs.
    """
    # Verify medication belongs to user
    med = await db.medications.find_one({
        "_id": ObjectId(data.medication_id),
        "user_id": current_user["id"]
    })
    if not med:
        raise HTTPException(status_code=404, detail="Medication not found")

    from datetime import date, timezone

    # Parse scheduled_time appropriately to match existing database logs
    # Mobile app sends "HH:MM", we must align it to today's date in local time
    if isinstance(data.scheduled_time, str):
        try:
            today = date.today()
            if ":" in data.scheduled_time and len(data.scheduled_time) <= 5:
                sh, sm = map(int, data.scheduled_time.split(":"))
                # Replicate the scheduler's original logic which created a naive datetime representing the scheduled slot
                today_start_naive = datetime(today.year, today.month, today.day, sh, sm, 0)
                # Convert naive local to UTC
                local_offset = datetime.now() - datetime.utcnow()
                sched_dt = today_start_naive - local_offset
            else:
                # Fallback parser if it's an ISO string
                dt = datetime.fromisoformat(data.scheduled_time.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    # It's a naive local time from Flutter, we need to convert it to UTC
                    local_offset = datetime.now() - datetime.utcnow()
                    sched_dt = dt - local_offset
                else:
                    sched_dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        except Exception:
            sched_dt = datetime.utcnow()
    else:
        # It's already a datetime (remove tzinfo if any since PyMongo handles naive as UTC)
        sched_dt = data.scheduled_time.replace(tzinfo=None)

    data.scheduled_time = sched_dt

    # Check for duplicate log for same dose slot (use ObjectId types to match stored format)
    existing = await db.medication_logs.find_one({
        "medication_id": ObjectId(data.medication_id),
        "user_id": ObjectId(current_user["id"]),
        "scheduled_time": data.scheduled_time
    })
    if existing:
        if existing.get("status") == "needs_verification" or existing.get("status") == "scheduled" or existing.get("status") == "pending":
            update_data = {"status": data.status.value if hasattr(data.status, "value") else data.status}
            if data.status == DoseStatus.taken:
                update_data["taken_at"] = datetime.utcnow()
            update_data["updated_at"] = datetime.utcnow()
            
            await db.medication_logs.update_one({"_id": existing["_id"]}, {"$set": update_data})
            created = await db.medication_logs.find_one({"_id": existing["_id"]})
            doc = serialize_doc(created)
            doc["medication_name"] = med["name"]
            doc["dosage"] = med["dosage"]
            
            # Use 200 OK since it's an update, but we'll return via 201 to make the app happy
            return doc
            
        raise HTTPException(status_code=409, detail="Log already exists for this dose. Use PATCH to update.")

    log_doc = medication_log_document(current_user["id"], data.model_dump())
    if data.status == DoseStatus.taken:
        log_doc["taken_at"] = datetime.utcnow()

    result = await db.medication_logs.insert_one(log_doc)
    created = await db.medication_logs.find_one({"_id": result.inserted_id})
    doc = serialize_doc(created)
    doc["medication_name"] = med["name"]
    doc["dosage"] = med["dosage"]
    return doc


@router.patch("/logs/{log_id}", response_model=MedicationLogResponse)
async def update_log(
    log_id: str,
    data: MedicationLogUpdate,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Update an existing log — e.g. user manually confirms after camera miss."""
    update_data = {k: v for k, v in data.model_dump().items() if v is not None}
    if data.status == DoseStatus.taken and "taken_at" not in update_data:
        update_data["taken_at"] = datetime.utcnow()
    update_data["updated_at"] = datetime.utcnow()

    from bson import ObjectId
    user_oid = ObjectId(current_user["id"]) if isinstance(current_user["id"], str) else current_user["id"]
    result = await db.medication_logs.update_one(
        {"_id": ObjectId(log_id), "user_id": user_oid},
        {"$set": update_data}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Log not found")

    updated = await db.medication_logs.find_one({"_id": ObjectId(log_id)})
    med = await db.medications.find_one({"_id": ObjectId(updated["medication_id"])})
    doc = serialize_doc(updated)
    doc["medication_name"] = med["name"] if med else "Unknown"
    doc["dosage"] = med["dosage"] if med else ""
    return doc


@router.get("/logs/history", response_model=List[MedicationLogResponse])
async def get_log_history(
    medication_id: Optional[str] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    status: Optional[DoseStatus] = None,
    user_id: Optional[str] = Query(default=None, alias="user_id"),
    limit: int = Query(default=50, le=200),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Get medication log history with optional filters.
    Caregivers can pass ?user_id=<id> to view a monitored user's history.
    Used by both user dashboard and caregiver dashboard.
    """
    target_id = await _resolve_target_user(user_id, current_user, db)

    from bson import ObjectId
    user_oid = ObjectId(target_id) if isinstance(target_id, str) else target_id
    query = {"user_id": user_oid}

    if medication_id:
        query["medication_id"] = ObjectId(medication_id) if isinstance(medication_id, str) else medication_id
    if status:
        query["status"] = status.value
    if start_date:
        start_naive = datetime(start_date.year, start_date.month, start_date.day)
        query.setdefault("scheduled_time", {})["$gte"] = datetime.utcfromtimestamp(start_naive.timestamp())
    if end_date:
        end_naive = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59)
        query.setdefault("scheduled_time", {})["$lte"] = datetime.utcfromtimestamp(end_naive.timestamp())

    cursor = db.medication_logs.find(query).sort("scheduled_time", -1).limit(limit)
    logs = await cursor.to_list(length=limit)

    results = []
    for log in logs:
        med = await db.medications.find_one({"_id": ObjectId(log["medication_id"])})
        doc = serialize_doc(log)
        doc["medication_name"] = med["name"] if med else "Unknown"
        doc["dosage"] = med["dosage"] if med else ""
        results.append(doc)
    return results


# ─── Adherence Summary ────────────────────────────────────────────────────────

@router.get("/summary/daily", response_model=DailyAdherenceSummary)
async def get_daily_summary(
    target_date: Optional[date] = None,
    user_id: Optional[str] = Query(default=None, alias="user_id"),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Get a full adherence summary for a given day.
    Caregivers can pass ?user_id=<id> to view a monitored user's summary.
    Defaults to today. Used by both dashboards.
    """
    target_user_id = await _resolve_target_user(user_id, current_user, db)

    target = target_date or date.today()
    day_start_naive = datetime(target.year, target.month, target.day, 0, 0, 0)
    day_end_naive   = datetime(target.year, target.month, target.day, 23, 59, 59)
    day_start = datetime.utcfromtimestamp(day_start_naive.timestamp())
    day_end   = datetime.utcfromtimestamp(day_end_naive.timestamp())

    from bson import ObjectId
    user_oid = ObjectId(target_user_id) if isinstance(target_user_id, str) else target_user_id
    
    cursor = db.medication_logs.find({
        "user_id": user_oid,
        "scheduled_time": {"$gte": day_start, "$lte": day_end}
    })
    logs = await cursor.to_list(length=200)

    counts = {s.value: 0 for s in DoseStatus}
    enriched = []
    for log in logs:
        counts[log["status"]] += 1
        med = await db.medications.find_one({"_id": ObjectId(log["medication_id"])})
        doc = serialize_doc(log)
        doc["medication_name"] = med["name"] if med else "Unknown"
        doc["dosage"] = med["dosage"] if med else ""
        enriched.append(doc)

    total = len(logs)
    taken = counts[DoseStatus.taken]
    adherence = round((taken / total * 100), 1) if total > 0 else 0.0

    return DailyAdherenceSummary(
        date=str(target),
        total_scheduled=total,
        taken=taken,
        missed=counts[DoseStatus.missed],
        snoozed=counts[DoseStatus.snoozed],
        skipped=counts[DoseStatus.skipped],
        adherence_percentage=adherence,
        medications=enriched
    )


# ─── Shorthand endpoints (Flutter app compatibility) ─────────────────────────

class DoseRecord(BaseModel):
    medication_id: str
    status: str  # taken, missed, snoozed, skipped
    notes: Optional[str] = None

@router.post("/dose")
async def record_dose(
    data: DoseRecord,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Quick dose recording from Flutter app — creates a log for today."""
    med = await db.medications.find_one({
        "_id": ObjectId(data.medication_id),
        "user_id": current_user["id"]
    })
    if not med:
        raise HTTPException(status_code=404, detail="Medication not found")

    now = datetime.now()
    log_doc = {
        "user_id": current_user["id"],
        "medication_id": data.medication_id,
        "scheduled_time": now,
        "status": data.status,
        "verification_method": "manual",
        "taken_at": now if data.status == "taken" else None,
        "notes": data.notes,
        "confidence_score": None,
        "keyframe_id": None,
        "created_at": now,
        "updated_at": now,
    }
    result = await db.medication_logs.insert_one(log_doc)
    created = await db.medication_logs.find_one({"_id": result.inserted_id})
    doc = serialize_doc(created)
    doc["medication_name"] = med["name"]
    doc["dosage"] = med["dosage"]
    return doc


@router.get("/history")
async def get_history(
    user_id: Optional[str] = None,
    limit: int = Query(default=30, le=200),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Get dose history — shorthand for Flutter app."""
    target = user_id or current_user["id"]
    cursor = db.medication_logs.find(
        {"user_id": target}
    ).sort("scheduled_time", -1).limit(limit)
    logs = await cursor.to_list(length=limit)

    results = []
    for log in logs:
        med = None
        try:
            med = await db.medications.find_one({"_id": ObjectId(log["medication_id"])})
        except Exception:
            pass
        doc = serialize_doc(log)
        doc["medication_name"] = med["name"] if med else "Unknown"
        doc["dosage"] = med["dosage"] if med else ""
        results.append(doc)
    return results


@router.get("/adherence/summary")
async def get_adherence_summary(
    user_id: Optional[str] = None,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Get weekly adherence summary — shorthand for Flutter app."""
    target = user_id or current_user["id"]
    now = datetime.now()
    week_ago = now - timedelta(days=7)

    cursor = db.medication_logs.find({
        "user_id": {"$in": [target, ObjectId(target) if ObjectId.is_valid(target) else target]},
        "scheduled_time": {"$gte": week_ago}
    })
    logs = await cursor.to_list(length=500)

    total = len(logs)
    taken = sum(1 for l in logs if l.get("status") == "taken")
    missed = sum(1 for l in logs if l.get("status") == "missed")
    
    # Adherence is calculated ONLY against taken + missed logs
    total_valid = taken + missed
    adherence = round((taken / total_valid * 100), 1) if total_valid > 0 else 0.0

    return {
        "total_scheduled": total,
        "taken": taken,
        "missed": missed,
        "adherence_percentage": adherence,
        "period": "7_days",
    }