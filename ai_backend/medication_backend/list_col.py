from pymongo import MongoClient
client = MongoClient('mongodb://localhost:27017/')
db = client['locus']
print("Collections:", db.list_collection_names())
client.close()
