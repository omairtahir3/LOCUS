import pymongo
from datetime import datetime

client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']

# Find all medication logs that are 'taken' but have no corresponding event log
taken_logs = list(db.medication_logs.find({"status": "taken"}))

for log in taken_logs:
    med = db.medications.find_one({"_id": log["medication_id"]})
    if not med:
        continue
        
    existing_event = db.eventlogs.find_one({
        "event_type": "medication_intake",
        "details.medication_id": med["_id"],
        "user_id": log["user_id"]
    })
    
    if not existing_event:
        print(f"Creating missing event log for {med['name']} taken at {log.get('taken_at')}")
        db.eventlogs.insert_one({
            "user_id": log["user_id"],
            "event_type": "medication_intake",
            "timestamp": log.get("taken_at") or datetime.utcnow(),
            "confidence": log.get("confidence_score") or 1.0,
            "details": {
                "medication_name": med["name"],
                "dosage": med["dosage"],
                "medication_id": med["_id"]
            },
            "keyframe_id": log.get("keyframe_id"),
            "verification_status": "confirmed"
        })
        
print("Backfill complete.")
