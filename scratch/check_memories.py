import pymongo
from bson import ObjectId
client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']
events = list(db.eventlogs.find({'user_id': ObjectId('6a5b37790bc066e70665f599')}).sort('timestamp', -1).limit(5))
for e in events:
    print(f"{e['timestamp']} - {e['event_type']} - {e.get('is_flagged')}")
