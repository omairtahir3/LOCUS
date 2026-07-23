const mongoose = require('mongoose');
const Medication = require('./models/Medication');
const MedicationLog = require('./models/MedicationLog');

async function run() {
  await mongoose.connect('mongodb://localhost:27017/locusDB');
  const user = await mongoose.connection.collection('users').findOne({ role: 'elderly' });
  const idStr = user._id.toString();
  const idOid = user._id;

  const today = new Date();
  const dayStart = new Date(today.setHours(0, 0, 0, 0));
  const dayEnd   = new Date(today.setHours(23, 59, 59, 999));

  const meds = await Medication.find({
    user_id: { $in: [idStr, idOid] },
    is_active: true
  });

  const logs = await MedicationLog.find({
    user_id: { $in: [idStr, idOid] },
    scheduled_time: { $gte: dayStart, $lte: dayEnd }
  });

  console.log('Meds:', meds.length);
  console.log('Logs today:', logs.length);
  console.log('DayStart:', dayStart.toISOString());
  console.log('DayEnd:', dayEnd.toISOString());

  const logMap = {};
  logs.forEach(l => { 
    const d = new Date(l.scheduled_time);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    console.log('Mapping log:', l.scheduled_time, 'to', hh + ':' + mm);
    logMap[`${l.medication_id}_${hh}:${mm}`] = l; 
  });

  const schedule = [];
  for (const med of meds) {
    for (const time of med.scheduled_times) {
      const key = `${med._id}_${time}`;
      const log = logMap[key];
      schedule.push({
        time: time,
        status: log?.status || 'scheduled'
      });
    }
  }
  console.log(schedule);
  process.exit(0);
}
run();
