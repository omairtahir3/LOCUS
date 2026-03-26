from fastapi import APIRouter, HTTPException, Depends, Query
from database import get_db
from schemas.medication import (
    MedicationCreate, MedicationUpdate, MedicationResponse,
    MedicationLogCreate, MedicationLogUpdate, MedicationLogResponse,
    DailyAdherenceSummary, MedicationScheduleItem, DoseStatus
)
from models.medication import medication_document, medication_log_document, serialize_doc, serialize_docs
from utils.auth import get_current_user
from bson import ObjectId
from datetime import datetime, date
from typing import List, Optional

router = APIRouter(prefix="/api/medications", tags=["Medications"])


# ─── Medication CRUD ──────────────────────────────────────────────────────────

@router.post("/", response_model=MedicationResponse, status_code=201)
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


@router.get("/", response_model=List[MedicationResponse])
async def get_medications(
    active_only: bool = True,
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """Get all medications for the current user."""
    query = {"user_id": current_user["id"]}
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
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Returns today's medication schedule for the user.
    For each active medication, shows each scheduled time and its current status.
    """
    today = date.today()
    today_start = datetime(today.year, today.month, today.day, 0, 0, 0)
    today_end   = datetime(today.year, today.month, today.day, 23, 59, 59)

    # Fetch all active medications
    meds_cursor = db.medications.find({"user_id": current_user["id"], "is_active": True})
    meds = await meds_cursor.to_list(length=100)

    # Fetch today's logs
    logs_cursor = db.medication_logs.find({
        "user_id": current_user["id"],
        "scheduled_time": {"$gte": today_start, "$lte": today_end}
    })
    logs = await logs_cursor.to_list(length=200)
    log_map = {f"{l['medication_id']}_{l['scheduled_time'].strftime('%H:%M')}": l for l in logs}

    schedule = []
    for med in meds:
        for time_str in med["scheduled_times"]:
            key = f"{str(med['_id'])}_{time_str}"
            log = log_map.get(key)
            status = DoseStatus(log["status"]) if log else DoseStatus.scheduled
            schedule.append(MedicationScheduleItem(
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

    # Check for duplicate log for same dose slot
    existing = await db.medication_logs.find_one({
        "medication_id": data.medication_id,
        "user_id": current_user["id"],
        "scheduled_time": data.scheduled_time
    })
    if existing:
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

    result = await db.medication_logs.update_one(
        {"_id": ObjectId(log_id), "user_id": current_user["id"]},
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
    limit: int = Query(default=50, le=200),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Get medication log history with optional filters.
    Used by both user dashboard and caregiver dashboard.
    """
    query = {"user_id": current_user["id"]}

    if medication_id:
        query["medication_id"] = medication_id
    if status:
        query["status"] = status.value
    if start_date:
        query.setdefault("scheduled_time", {})["$gte"] = datetime(start_date.year, start_date.month, start_date.day)
    if end_date:
        query.setdefault("scheduled_time", {})["$lte"] = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59)

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
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    Get a full adherence summary for a given day.
    Defaults to today. Used by both dashboards.
    """
    target = target_date or date.today()
    day_start = datetime(target.year, target.month, target.day, 0, 0, 0)
    day_end   = datetime(target.year, target.month, target.day, 23, 59, 59)

    cursor = db.medication_logs.find({
        "user_id": current_user["id"],
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