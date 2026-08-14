const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const JWT_SECRET = '36322068b25f38cbadf8347036ef5cdf55ce653a16a18c86a2f825caea6d4bcf36e9a10baef931e4a22a00bf3d80a0610c30ceb43146630de2ec2310562f3178';

async function run() {
  await mongoose.connect('mongodb://127.0.0.1:27017/locusDB');
  
  const user = await mongoose.connection.db.collection('users').findOne({ role: 'caregiver' });
  const token = jwt.sign({ user: { id: user._id.toString(), role: user.role } }, JWT_SECRET);
  
  const eventRes = await mongoose.connection.db.collection('eventlogs').insertOne({
    user_id: user.connected_elderly_user,
    event_type: 'unknown_face',
    timestamp: new Date(),
    confidence: 0.9,
    verification_status: 'pending',
    details: { face_embedding: [0.1, 0.2, 0.3] }
  });
  
  const eventId = eventRes.insertedId.toString();
  console.log("Created dummy event:", eventId);
  
  console.log("POSTing to /api/relationships/confirm...");
  const res = await fetch('http://127.0.0.1:5000/api/relationships/confirm', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      eventId,
      personName: 'Omair',
      relationshipType: 'Test'
    })
  });
  
  console.log(`Status Code: ${res.status}`);
  const data = await res.json();
  console.log("Response Body:", JSON.stringify(data, null, 2));
  
  await mongoose.connection.db.collection('eventlogs').deleteOne({ _id: eventRes.insertedId });
  await mongoose.disconnect();
}

run().catch(console.error);
