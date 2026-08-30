const mongoose = require('mongoose');
const EventLog = require('./models/EventLog');
const LocationLog = require('./models/LocationLog');

mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const latestLoc = await LocationLog.findOne({ user_id: "6a5b37790bc066e70665f599" }).sort({ timestamp: -1 });
  
  const doc = {
    user_id: "6a5b37790bc066e70665f599",
    event_type: "social_interaction",
    timestamp: new Date(),
    details: { person: "Mock GPS Tester" },
    confidence: 0.99
  };

  if (latestLoc) {
    const staleness = (new Date() - new Date(latestLoc.timestamp)) / 1000 / 60;
    if (staleness <= 30) {
      doc.location = { lat: latestLoc.lat, lng: latestLoc.lng };
      console.log("Attached fresh location:", doc.location);
    } else {
      console.log("Location was stale:", staleness, "mins");
    }
  }

  const saved = await EventLog.create(doc);
  console.log("Event inserted:", saved._id);
  process.exit(0);
});
