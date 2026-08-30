import pymongo
import json
client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']
logs = list(db.medication_logs.find().sort('scheduled_time', -1).limit(10))
for l in logs:
    print(f"User: {l.get('user_id')} - Med: {l.get('medication_id')} - Status: {l.get('status')} - Time: {l.get('scheduled_time')}")
