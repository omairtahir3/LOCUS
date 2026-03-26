from datetime import datetime


def medication_document(user_id: str, data: dict) -> dict:
    """Build a medication document to insert into MongoDB."""
    return {
        "user_id": user_id,
        "name": data["name"],
        "dosage": data["dosage"],
        "frequency": data["frequency"],
        "scheduled_times": data["scheduled_times"],
        "days_of_week": data.get("days_of_week"),
        "instructions": data.get("instructions"),
        "start_date": data["start_date"],
        "end_date": data.get("end_date"),
        "snooze_duration_minutes": data.get("snooze_duration_minutes", 10),
        "caregiver_notify_on_miss": data.get("caregiver_notify_on_miss", True),
        "is_active": True,
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }


def medication_log_document(user_id: str, data: dict) -> dict:
    """Build a medication log document to insert into MongoDB."""
    return {
        "user_id": user_id,
        "medication_id": data["medication_id"],
        "scheduled_time": data["scheduled_time"],
        "taken_at": data.get("taken_at"),
        "status": data["status"],
        "verification_method": data.get("verification_method"),
        "notes": data.get("notes"),
        "confidence_score": data.get("confidence_score"),
        "keyframe_id": data.get("keyframe_id"),
        "snoozed_until": data.get("snoozed_until"),
        "created_at": datetime.utcnow(),
        "updated_at": datetime.utcnow(),
    }


def serialize_doc(doc: dict) -> dict:
    """Convert MongoDB _id to string id for API responses."""
    if doc and "_id" in doc:
        doc["id"] = str(doc.pop("_id"))
    return doc


def serialize_docs(docs: list) -> list:
    """Serialize a list of MongoDB documents."""
    return [serialize_doc(doc) for doc in docs]