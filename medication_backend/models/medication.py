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


from bson import ObjectId

def medication_log_document(user_id: str, data: dict) -> dict:
    """Build a medication log document to insert into MongoDB."""
    return {
        "user_id": ObjectId(user_id) if isinstance(user_id, str) else user_id,
        "medication_id": ObjectId(data["medication_id"]) if isinstance(data["medication_id"], str) else data["medication_id"],
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
    """Convert MongoDB _id and any nested ObjectIds to strings for API compatibility natively."""
    from bson import ObjectId
    from datetime import datetime as _dt
    if not doc:
        return doc
        
    for k, v in doc.items():
        if isinstance(v, ObjectId):
            doc[k] = str(v)
        elif isinstance(v, _dt):
            # Append Z to signal UTC so clients (Flutter/JS) convert to local time correctly
            doc[k] = v.isoformat() + "Z"
            
    if "_id" in doc:
        doc["id"] = str(doc.pop("_id"))
        doc["_id"] = doc["id"] # Flutter and React occasionally bind against exact key variations dynamically natively
        
    return doc


def serialize_docs(docs: list) -> list:
    """Serialize a list of MongoDB documents."""
    return [serialize_doc(doc) for doc in docs]