const mongoose = require('mongoose');
const MedicationLog = require('./models/MedicationLog');
const Notification = require('./models/Notification');

async function run() {
  await mongoose.connect('mongodb://localhost:27017/locusDB');
  
  const logResult = await MedicationLog.deleteMany({});
  const notifResult = await Notification.deleteMany({});
  
  console.log('Deleted all logs:', logResult.deletedCount);
  console.log('Deleted all notifications:', notifResult.deletedCount);
  process.exit(0);
}
run();
