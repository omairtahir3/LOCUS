const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/locus').then(async () => {
  require('./models/User');
  require('./models/Medication');
  const MedicationLog = require('./models/MedicationLog');
  const Notification = require('./models/Notification');
  
  const logs = await MedicationLog.find({ status: { $in: ['missed', 'skipped'] } })
    .sort({ createdAt: -1 }).limit(10)
    .populate('medication_id', 'name caregiver_notify_on_miss')
    .populate('user_id', 'name role caregiver_ids');
  
  console.log('=== MISSED/SKIPPED LOGS (last 10) ===');
  logs.forEach(l => console.log(JSON.stringify({
    med: l.medication_id?.name, status: l.status, user: l.user_id?.name,
    role: l.user_id?.role, caregiver_ids: l.user_id?.caregiver_ids,
    notify_on_miss: l.medication_id?.caregiver_notify_on_miss,
    scheduled: l.scheduled_time, reminder_count: l.reminder_count
  })));

  console.log('\n=== CAREGIVER NOTIFICATIONS (missed_dose/skipped) ===');
  const notifs = await Notification.find({ type: { $in: ['missed_dose', 'skipped_medicine'] } })
    .sort({ createdAt: -1 }).limit(10);
  notifs.forEach(n => console.log(JSON.stringify({
    type: n.type, title: n.title, recipient: n.recipient_id,
    subject_user: n.subject_user_id, created: n.createdAt, dismissed: n.is_dismissed
  })));
  if (notifs.length === 0) console.log('NO caregiver missed_dose/skipped notifications found!');

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
