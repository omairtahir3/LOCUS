import pymongo
from datetime import datetime, timedelta

client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']

# Find all medication logs that are 'taken' but have no corresponding event log
taken_logs = list(db.medication_logs.find({"status": "taken"}))

count = 0
for log in taken_logs:
    med = db.medications.find_one({"_id": log["medication_id"]})
    if not med:
        continue
    
    taken_at = log.get("taken_at") or log.get("scheduled_time")
    if not taken_at:
        continue

    # Look for an event close in time
    start_time = taken_at - timedelta(hours=2)
    end_time = taken_at + timedelta(hours=2)

    existing_event = db.eventlogs.find_one({
        "event_type": "medication_intake",
        "details.medication_id": med["_id"],
        "user_id": log["user_id"],
        "timestamp": {"$gte": start_time, "$lte": end_time}
    })
    
    if not existing_event:
        print(f"Creating missing event log for {med['name']} taken at {taken_at}")
        db.eventlogs.insert_one({
            "user_id": log["user_id"],
            "event_type": "medication_intake",
            "timestamp": taken_at,
            "confidence": log.get("confidence_score") or 1.0,
            "details": {
                "medication_name": med["name"],
                "dosage": med["dosage"],
                "medication_id": med["_id"]
            },
            "keyframe_id": log.get("keyframe_id"),
            "verification_status": "confirmed"
        })
        count += 1
        
print(f"Backfill complete. Created {count} missing events.")
