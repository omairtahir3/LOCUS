import requests
import json
from pymongo import MongoClient
import bson

client = MongoClient("mongodb://localhost:27017/")
db = client["locusDB"]
uid = "6a5b37790bc066e70665f599" # Mohammad Tahir
med = db.medications.find_one({"user_id": bson.ObjectId(uid)})

if not med:
    print("Med not found")
else:
    payload = {
        "user_id": uid,
        "medication_id": str(med["_id"]),
        "status": "camera_off",
        "notes": "Testing system alert endpoint"
    }
    print(f"Sending payload: {payload}")
    try:
        resp = requests.post("http://localhost:5000/api/notifications/system-alert", json=payload)
        print(resp.status_code)
        print(resp.text)
    except Exception as e:
        print("Error:", e)
