import pymongo
from bson import ObjectId
import json
client = pymongo.MongoClient('mongodb://127.0.0.1:27017/')
db = client['locusDB']
logs = list(db.medicationlogs.find({
    'user_id': ObjectId('6a5b37790bc066e70665f599')
}).sort('scheduled_time', -1).limit(5))
for l in logs:
    print(f"{l.get('scheduled_time')} - {l.get('status')}")
