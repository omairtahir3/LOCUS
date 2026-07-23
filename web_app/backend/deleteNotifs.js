const mongoose = require('mongoose');
const Notification = require('./models/Notification');

async function run() {
  await mongoose.connect('mongodb://localhost:27017/locusDB');
  const countBefore = await Notification.countDocuments();
  console.log('Total notifications before:', countBefore);
  
  const res = await Notification.deleteMany({
    type: { $in: ['missed_dose', 'dose_reminder', 'dose_confirmed', 'skipped_medicine'] }
  });
  console.log('Deleted medicine notifications:', res.deletedCount);
  
  const countAfter = await Notification.countDocuments();
  console.log('Total notifications after:', countAfter);
  
  process.exit(0);
}
run();
