const mongoose = require('mongoose');
const EventLog = require('./models/EventLog');
require('dotenv').config();

async function clearLocations() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to DB');
    
    const result = await EventLog.updateMany({}, { $unset: { location: "" } });
    console.log(`Cleared location from ${result.modifiedCount} events.`);
    
    mongoose.connection.close();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

clearLocations();
