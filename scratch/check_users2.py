import pymongo
client = pymongo.MongoClient("mongodb://127.0.0.1:27017/")
db = client["locusDB"]

print("==== Users ====")
for user in db.users.find({}):
    print(f"ID: {user.get('_id')} - Name: {user.get('name')} - Role: {user.get('role')} - Camera: {user.get('camera_stream_url')}")
