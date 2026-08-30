from pymongo import MongoClient
import os

client = MongoClient("mongodb://localhost:27017/")
db = client["locusDB"]

uid = "6a5b37790bc066e70665f599" # Mohammad Tahir

from bson import ObjectId
logs = db.medication_logs.find({"user_id": ObjectId(uid)})
for log in logs:
    med = db.medications.find_one({"_id": log["medication_id"]})
    print(f"[{log['scheduled_time']}] {med['name'] if med else 'Unknown'}: {log['status']} (notes: {log.get('notes')})")
