const mongoose = require('mongoose');
const Relationship = require('c:/Users/dell/Desktop/LOCUS/web_app/backend/models/Relationship');

mongoose.connect('mongodb://localhost:27017/locusDB').then(async () => {
  try {
    const relationship = new Relationship({
      user_id: new mongoose.Types.ObjectId(),
      person_name: 'Test',
      face_embedding: [0.1, 0.2],
      confirmed_by: 'user', // From req.user.role where role='user'
    });
    await relationship.save();
    console.log("SUCCESS");
  } catch (e) {
    console.log("STATUS CODE: 500");
    console.log("RESPONSE BODY: { error: 'Server error' }");
    console.log("BACKEND STACK TRACE:");
    console.log(e.stack);
  }
  process.exit();
});
