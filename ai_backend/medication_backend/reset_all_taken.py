from pymongo import MongoClient

client = MongoClient('mongodb://localhost:27017/')
db = client['locusDB']
collection = db['medication_logs']

# find logs with status 'taken' and reset them
query = {'status': 'taken'}
result = collection.update_many(query, {'$set': {'status': 'scheduled', 'taken_at': None, 'verified_by_ai': False, 'confidence_score': None, 'keyframe_id': None}})
print(f'Reset {result.modified_count} logs to scheduled')
client.close()
