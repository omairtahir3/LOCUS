const mongoose = require('mongoose');
mongoose.connect('mongodb://127.0.0.1:27017/locusDB').then(async () => {
  const db = mongoose.connection.db;
  
  // Delete missed dose notifications for Mohammad Tahir's caregiver
  const result = await db.collection('notifications').deleteMany({
    type: { $in: ['missed_dose', 'skipped_medicine'] },
    subject_user_id: new mongoose.Types.ObjectId('6a5b37790bc066e70665f599')
  });
  console.log('Deleted notifications:', result.deletedCount);

  // Verify
  const remaining = await db.collection('notifications').find({
    type: { $in: ['missed_dose', 'skipped_medicine'] },
    subject_user_id: new mongoose.Types.ObjectId('6a5b37790bc066e70665f599')
  }).toArray();
  console.log('Remaining notifications for Mohammad:', remaining.length);

  process.exit(0);
});
