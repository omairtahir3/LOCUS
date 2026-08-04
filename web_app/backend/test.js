const mongoose = require('mongoose');
const User = require('./models/User');
const MedicationLog = require('./models/MedicationLog');
const Medication = require('./models/Medication');

mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const user = await User.findOne({ name: 'Mohammad Tahir' });
  const today = new Date();
  const dayStart = new Date(today.setHours(0, 0, 0, 0));
  const dayEnd   = new Date(today.setHours(23, 59, 59, 999));
  
  const fetchedLogs = await MedicationLog.find({
      user_id: user._id,
      scheduled_time: { $gte: dayStart, $lte: dayEnd }
  }).populate('medication_id');
  
  console.log('dayStart:', dayStart.toISOString());
  console.log('dayEnd:', dayEnd.toISOString());
  
  console.log('\nLogs fetched for today:');
  fetchedLogs.forEach(l => {
    const d = new Date(l.scheduled_time);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    console.log(l.medication_id.name, l.scheduled_time.toISOString(), hh+':'+mm, l.status);
  });
  
  const meds = await Medication.find({ user_id: user._id });
  console.log('\nSchedule construction:');
  const logMap = {};
  fetchedLogs.forEach(l => { 
    const d = new Date(l.scheduled_time);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    logMap[`${l.medication_id._id}_${hh}:${mm}`] = l; 
  });
  for (const med of meds) {
    for (const time of med.scheduled_times) {
       const key = `${med._id}_${time}`;
       const log = logMap[key];
       console.log('Med:', med.name, 'Time:', time, 'Found log status:', log ? log.status : 'None - so falls back to scheduled');
    }
  }
  process.exit(0);
});
