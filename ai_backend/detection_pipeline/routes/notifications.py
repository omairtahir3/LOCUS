from fastapi import APIRouter, Depends, Query, HTTPException
from typing import List, Optional
from bson import ObjectId
from database import get_db
from routes.auth import get_current_user

router = APIRouter(prefix="/api/notifications", tags=["notifications"])

def serialize_notif(notif: dict) -> dict:
    if "_id" in notif:
        notif["id"] = str(notif.pop("_id"))
        notif["_id"] = notif["id"]
    for key in ["recipient_id", "subject_user_id"]:
        if key in notif and isinstance(notif[key], ObjectId):
            notif[key] = str(notif[key])
    for key in ["createdAt", "updatedAt", "read_at", "acknowledged_at", "created_at", "updated_at"]:
        if key in notif and notif[key]:
            notif[key] = notif[key].isoformat() + "Z"
    return notif

@router.get("/")
async def get_notifications(
    limit: int = Query(30),
    unread_only: bool = Query(False),
    db=Depends(get_db),
    current_user=Depends(get_current_user)
):
    query = {
        "recipient_id": ObjectId(current_user["id"]),
        "is_dismissed": {"$ne": True}
    }
    if unread_only:
        query["is_read"] = False

    cursor = db.notifications.find(query).sort("createdAt", -1).limit(limit)
    notifications = await cursor.to_list(length=limit)

    unread_count = await db.notifications.count_documents({
        "recipient_id": ObjectId(current_user["id"]),
        "is_read": False,
        "is_dismissed": {"$ne": True}
    })

    serialized = [serialize_notif(n) for n in notifications]
    return {"notifications": serialized, "unread_count": unread_count}

@router.patch("/{notif_id}/read")
async def mark_read(notif_id: str, db=Depends(get_db), current_user=Depends(get_current_user)):
    from datetime import datetime
    result = await db.notifications.update_one(
        {"_id": ObjectId(notif_id), "recipient_id": ObjectId(current_user["id"])},
        {"$set": {"is_read": True, "read_at": datetime.utcnow()}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"message": "Marked as read"}

@router.patch("/read-all")
async def mark_all_read(db=Depends(get_db), current_user=Depends(get_current_user)):
    from datetime import datetime
    await db.notifications.update_many(
        {"recipient_id": ObjectId(current_user["id"]), "is_read": False},
        {"$set": {"is_read": True, "read_at": datetime.utcnow()}}
    )
    return {"message": "All notifications marked as read"}

@router.patch("/{notif_id}/acknowledge")
async def acknowledge_notification(notif_id: str, db=Depends(get_db), current_user=Depends(get_current_user)):
    from datetime import datetime
    result = await db.notifications.update_one(
        {"_id": ObjectId(notif_id), "recipient_id": ObjectId(current_user["id"])},
        {"$set": {"acknowledged_at": datetime.utcnow(), "is_read": True, "read_at": datetime.utcnow()}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"message": "Notification acknowledged"}

@router.delete("/{notif_id}")
async def dismiss_notification(notif_id: str, db=Depends(get_db), current_user=Depends(get_current_user)):
    result = await db.notifications.update_one(
        {"_id": ObjectId(notif_id), "recipient_id": ObjectId(current_user["id"])},
        {"$set": {"is_dismissed": True}}
    )
    if result.modified_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found")
    return {"message": "Notification dismissed"}
