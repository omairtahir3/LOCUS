from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017/")
db = client["locusDB"]

uid = "6a5b37790bc066e70665f599" # Mohammad Tahir
from bson import ObjectId

# Delete the most recent camera_off log to test backfill triggering it again
latest = db.medication_logs.find_one({"user_id": ObjectId(uid), "status": "camera_off"}, sort=[("scheduled_time", -1)])
if latest:
    db.medication_logs.delete_one({"_id": latest["_id"]})
    print(f"Deleted camera_off log for {latest['scheduled_time']} for testing.")
