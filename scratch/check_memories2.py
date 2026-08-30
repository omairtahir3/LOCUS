import pymongo
from bson import ObjectId
import json
client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']
events = list(db.eventlogs.find({
    'user_id': ObjectId('6a5b37790bc066e70665f599'),
    'event_type': {'$in': ['medication_intake', 'social_interaction']},
    'verification_status': {'$ne': 'rejected'}
}).sort('timestamp', -1).limit(5))

for e in events:
    print(f"{e['timestamp']} - {e['event_type']} - flagged: {e.get('is_flagged')}")
    print(e.get('details'))
