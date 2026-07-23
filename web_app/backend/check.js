const mongoose = require('mongoose');
const MedicationLog = require('./models/MedicationLog');
const Medication = require('./models/Medication');

async function run() {
  await mongoose.connect('mongodb://localhost:27017/locusDB');
  const logs = await MedicationLog.find({ 
    status: { $ne: 'scheduled' }
  }).populate('medication_id');
  console.log('Processed logs:', logs.map(l => ({ 
    time: l.scheduled_time, 
    status: l.status, 
    med: l.medication_id?.name, 
    caregiverNotified: l.caregiver_notified
  })).slice(-10)); // Just the last 10
  process.exit(0);
}
run();
