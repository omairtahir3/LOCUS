from pymongo import MongoClient

client = MongoClient("mongodb://localhost:27017/")
db = client["locusDB"]

uid = "6a5b37790bc066e70665f599" # Mohammad Tahir
from bson import ObjectId

# Get the most recent notification for this user
notif = db.notifications.find_one({"recipient_id": ObjectId(uid)}, sort=[("created_at", -1)])
if notif:
    print(f"Latest Notification: {notif.get('title')}")
    print(f"Message: {notif.get('message')}")
    print(f"Type: {notif.get('type')}")
    print(f"Email sent: {notif.get('delivery', {}).get('email', {}).get('sent')}")
else:
    print("No notifications found.")
