const today = new Date();
today.setHours(0, 0, 0, 0);
const result = db.getSiblingDB('locusDB').medicationlogs.deleteMany({
  scheduled_time: { $gte: today }
});
print('Deleted ' + result.deletedCount + ' medication log(s) from today');
