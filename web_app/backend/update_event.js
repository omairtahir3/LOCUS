const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const db = mongoose.connection.db;
  await db.collection('eventlogs').updateOne(
    { _id: new mongoose.Types.ObjectId('6a934720dca12fa380901325') },
    { $set: { location: { lat: 33.7118, lng: 73.0940 } } }
  );
  console.log('Updated event with location');
  process.exit(0);
});
