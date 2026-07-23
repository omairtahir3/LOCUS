from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017")
db = client["locusDB"]

meds = list(db.medications.find({"is_active": True}))
print("All active medications with their schedules:")
for m in meds:
    name = m.get("name", "?")
    times = m.get("scheduled_times", [])
    uid = m.get("user_id", "?")
    mid = m["_id"]
    print(f"  {mid} | {name} | scheduled_times: {times} | user: {uid}")

# Now delete all logs
print(f"\n--- DELETING ALL {db.medication_logs.count_documents({})} LOGS ---")
result = db.medication_logs.delete_many({})
print(f"Deleted {result.deleted_count} logs. DB is clean for testing.")

client.close()
