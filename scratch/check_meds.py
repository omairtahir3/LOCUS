from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017/")
db = client["locusDB"]

uid = "6a5b37790bc066e70665f599" # Mohammad Tahir
from bson import ObjectId
meds = db.medications.find({"user_id": ObjectId(uid)})
for med in meds:
    print(f"Med: {med['name']}, Times: {med.get('scheduled_times')}")
