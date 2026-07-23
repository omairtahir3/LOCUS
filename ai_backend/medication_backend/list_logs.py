from pymongo import MongoClient
import json

client = MongoClient('mongodb://localhost:27017/')
db = client['locus']
collection = db['medication_logs']

logs = collection.find().sort('date', -1).limit(10)
for log in logs:
    print(f"ID: {log['_id']}, Med: {log['medication_id']}, Time: {log['scheduled_time']}, Status: {log['status']}, Date: {log.get('date')}")
client.close()
