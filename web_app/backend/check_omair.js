const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const db = mongoose.connection.db;
  const omair = await db.collection('users').findOne({name: { $regex: /omair/i }});
  console.log('Omair ID:', omair._id, 'Role:', omair.role);
  const events = await db.collection('eventlogs').find({user_id: omair._id, event_type: 'social_interaction'}).sort({timestamp: -1}).limit(3).toArray();
  console.log('Recent events:', JSON.stringify(events, null, 2));
  const locs = await db.collection('userlocations').find({user_id: omair._id}).sort({timestamp: -1}).limit(1).toArray();
  console.log('Recent locations:', JSON.stringify(locs, null, 2));
  process.exit(0);
});
