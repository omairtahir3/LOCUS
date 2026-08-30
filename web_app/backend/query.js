const mongoose = require('mongoose');
const EventLog = require('./models/EventLog');
mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const logs = await EventLog.find({ event_type: { $in: ['social_interaction', 'medication_intake', 'unknown_face'] } })
    .select('event_type location timestamp')
    .sort({timestamp:-1})
    .limit(5);
  console.log(JSON.stringify(logs, null, 2));
  process.exit(0);
});
