from pymongo import MongoClient
import json

client = MongoClient('mongodb://localhost:27017/')
db = client['locusDB']
collection = db['medication_logs']

# find logs with status 'taken' for today
query = {'scheduled_time': '04:00'}
result = collection.update_many(query, {'$set': {'status': 'scheduled', 'taken_at': None, 'verified_by_ai': False, 'confidence_score': None, 'keyframe_id': None}})
print(f'Reset {result.modified_count} logs for 04:00 to scheduled')
client.close()
