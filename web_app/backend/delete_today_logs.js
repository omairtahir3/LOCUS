const mongoose = require('mongoose');
mongoose.connect('mongodb://localhost:27017/locusDB').then(async () => {
  const r = await mongoose.connection.db.collection('medication_logs').deleteOne({
    _id: new mongoose.Types.ObjectId('69fdc08fbcf6d44fb649ff88')
  });
  console.log('Deleted', r.deletedCount, 'log (16:30 missed log)');
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
