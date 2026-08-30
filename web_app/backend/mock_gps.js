const mongoose = require('mongoose');
const LocationLog = require('./models/LocationLog');
mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  await LocationLog.create({
    user_id: "6a5b37790bc066e70665f599", // Elderly user ID
    lat: 34.0522, // Los Angeles
    lng: -118.2437,
    accuracy: 10,
    speed: 0,
    timestamp: new Date()
  });
  console.log("Mock fresh GPS ping inserted!");
  process.exit(0);
});
