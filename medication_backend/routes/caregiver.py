from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import JSONResponse
from database import get_db
from utils.auth import get_current_user
from bson import ObjectId
from datetime import datetime, time, date, timedelta
from typing import List
import json

router = APIRouter(prefix="/api/caregiver", tags=["Caregiver"])


class MongoEncoder(json.JSONEncoder):
    """Custom JSON encoder that handles MongoDB types."""
    def default(self, obj):
        if isinstance(obj, ObjectId):
            return str(obj)
        if isinstance(obj, (datetime, date)):
            return obj.isoformat()
        return super().default(obj)


def serialize_doc(doc: dict) -> dict:
    """Deep-serialize a MongoDB document so it's fully JSON-safe."""
    if doc is None:
        return {}
    raw = json.loads(json.dumps(doc, cls=MongoEncoder))
    # Provide both _id and id for cross-platform compat (Flutter uses _id, web uses id)
    if "_id" in raw:
        raw["id"] = raw["_id"]
    return raw


@router.get("/users")
async def get_monitored_users(current_user=Depends(get_current_user), db=Depends(get_db)):
    """List all users this caregiver monitors"""
    if current_user.get("role") not in ["caregiver", "admin"]:
        raise HTTPException(status_code=403, detail="Access denied")

    caregiver = await db.users.find_one({"_id": ObjectId(current_user["id"])})
    if not caregiver:
        raise HTTPException(status_code=404, detail="Caregiver not found")

    monitoring_ids = caregiver.get("monitoring_users", [])

    # Convert string IDs back to ObjectIds just to be safe
    obj_ids = []
    for mid in monitoring_ids:
        try:
            obj_ids.append(ObjectId(mid) if isinstance(mid, str) else mid)
        except Exception:
            pass

    users_cursor = db.users.find({"_id": {"$in": obj_ids}}, {"password": 0})
    users = await users_cursor.to_list(length=100)

    return JSONResponse(content=[serialize_doc(u) for u in users])


@router.get("/users/{user_id}/summary")
async def get_user_summary(user_id: str, current_user=Depends(get_current_user), db=Depends(get_db)):
    """Dashboard summary for one patient."""
    if current_user.get("role") not in ["caregiver", "admin"]:
        raise HTTPException(status_code=403, detail="Access denied")

    caregiver = await db.users.find_one({"_id": ObjectId(current_user["id"])})
    monitoring_ids = [str(x) for x in caregiver.get("monitoring_users", [])]

    if user_id not in monitoring_ids and current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Access denied to this user")

    target_user = await db.users.find_one({"_id": ObjectId(user_id)}, {"password": 0})
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    now = datetime.utcnow()
    week_ago = now - timedelta(days=7)

    logs_cursor = db.medication_logs.find({
        "user_id": {"$in": [user_id, ObjectId(user_id) if ObjectId.is_valid(user_id) else user_id]},
        "scheduled_time": {"$gte": week_ago}
    })
    logs = await logs_cursor.to_list(length=500)

    counts = {"taken": 0, "missed": 0, "snoozed": 0, "skipped": 0, "scheduled": 0, "needs_verification": 0}
    for log in logs:
        status = log.get("status", "scheduled")
        if status in counts:
            counts[status] += 1

    total_logs = len(logs)
    total_valid = counts["taken"] + counts["missed"]
    adherence_pct = round((counts["taken"] / total_valid) * 100, 1) if total_valid > 0 else 0.0

    # Process medications for logging serialization
    serialized_logs = []
    for log in logs:
        med = await db.medications.find_one({"_id": ObjectId(log["medication_id"])})
        doc = serialize_doc(log)
        doc["medication_name"] = med["name"] if med else "Unknown"
        doc["dosage"] = med["dosage"] if med else ""
        serialized_logs.append(doc)

    # Unread notifications
    try:
        notifs_cursor = db.notifications.find({
            "recipient_id": ObjectId(current_user["id"]),
            "subject_user_id": ObjectId(user_id),
            "is_read": False
        }).sort("created_at", -1).limit(10)
        pending_alerts = await notifs_cursor.to_list(length=10)
    except Exception:
        pending_alerts = []

    return JSONResponse(content={
        "user": serialize_doc(target_user),
        "today_adherence": {
            **counts,
            "total": total_logs,
            "adherence_percentage": adherence_pct,
            "logs": serialized_logs
        },
        "pending_alerts": [serialize_doc(n) for n in pending_alerts]
    })


from pydantic import BaseModel

class MessagePayload(BaseModel):
    title: str
    message: str

@router.post("/users/{user_id}/message")
async def send_message(user_id: str, payload: MessagePayload, current_user=Depends(get_current_user), db=Depends(get_db)):
    """Send a message/notification to the target user."""
    doc = {
        "recipient_id": ObjectId(user_id),
        "sender_id": ObjectId(current_user["id"]),
        "type": "message",
        "title": payload.title,
        "message": payload.message,
        "is_read": False,
        "created_at": datetime.utcnow()
    }
    await db.notifications.insert_one(doc)
    return {"status": "success", "message": "Message sent successfully"}


@router.post("/users/{user_id}/status-check")
async def request_status_check(user_id: str, current_user=Depends(get_current_user), db=Depends(get_db)):
    """Request a status check from the target user."""
    doc = {
        "recipient_id": ObjectId(user_id),
        "sender_id": ObjectId(current_user["id"]),
        "type": "status_check",
        "title": "Status Check Requested",
        "message": "Your caregiver has requested a quick status check. Please tap to respond.",
        "is_read": False,
        "created_at": datetime.utcnow()
    }
    await db.notifications.insert_one(doc)
    return {"status": "success", "message": "Status check requested successfully"}


@router.get("/users/{user_id}/verification-events")
async def get_verification_events(user_id: str, limit: int = 20, db=Depends(get_db)):
    """Fetch AI verification events (camera validations)."""
    logs_cursor = db.medication_logs.find({
        "user_id": {"$in": [user_id, ObjectId(user_id) if ObjectId.is_valid(user_id) else user_id]},
        "verification_method": "visual",
        "confidence_score": {"$ne": None}
    }).sort("scheduled_time", -1).limit(limit)
    
    logs = await logs_cursor.to_list(length=limit)
    
    events = []
    for log in logs:
        conf = log.get("confidence_score", 0)
        classification = "unverified"
        action = "discard"
        if conf >= 0.845:
            classification = "auto_verified"
            action = "log_automatically"
        elif conf >= 0.65:
            classification = "needs_confirmation"
            action = "request_user_confirmation"
            
        med_id = log.get("medication_id")
        med = await db.medications.find_one({"_id": ObjectId(med_id)}) if med_id else None
        
        events.append({
            "_id": str(log["_id"]),
            "medication_name": med["name"] if med else "Unknown",
            "dosage": med.get("dosage", "") if med else "",
            "scheduled_time": log.get("scheduled_time").isoformat() if log.get("scheduled_time") else None,
            "taken_at": log.get("taken_at").isoformat() if log.get("taken_at") else None,
            "status": log.get("status"),
            "confidence_score": conf,
            "classification": classification,
            "action": action,
            "keyframe_id": log.get("keyframe_id"),
            "created_at": log.get("created_at").isoformat() if log.get("created_at") else None
        })
        
    return JSONResponse(content=events)


@router.get("/users/{user_id}/anomalies")
async def get_anomalies(user_id: str, db=Depends(get_db)):
    """Fetch behavioral anomalies."""
    # Simplified version for FastAPI stub to prevent 404s in app
    return JSONResponse(content=[])
