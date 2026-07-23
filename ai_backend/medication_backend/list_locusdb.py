from pymongo import MongoClient

client = MongoClient('mongodb://localhost:27017/')
db = client['locusDB']
collection = db['medication_logs']

logs = collection.find().sort('scheduled_time', -1).limit(20)
for log in logs:
    print(f"ID: {log['_id']}, Time: {log.get('scheduled_time')}, Status: {log.get('status')}")
client.close()
