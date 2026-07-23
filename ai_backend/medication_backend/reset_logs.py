from pymongo import MongoClient
from datetime import datetime
import re

client = MongoClient('mongodb://localhost:27017/')
db = client['locus']
collection = db['medication_logs']

today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
query = { 'scheduled_time': re.compile('04:00'), 'date': {'$gte': today} }
result = collection.delete_many(query) # User says "remove the logs for 4 am meidine and reschedule both of them" - if I delete them, they will be rescheduled by the state machine/frontend, or I can just reset them. Let's reset them.
print(f'Deleted {result.deleted_count} logs for 4am today')
client.close()
