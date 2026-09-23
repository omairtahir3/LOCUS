const mongoose = require('mongoose');

/**
 * One row per user per day: how many steps the phone counted.
 *
 * The phone's pedometer reports steps since the device last rebooted, not
 * steps today, so the mobile app works out the daily figure and sends THAT.
 * Keeping the arithmetic on the device means a reboot, a reinstall or a day
 * boundary is handled where the baseline actually lives; the server only
 * stores the answer.
 *
 * `date` is a plain YYYY-MM-DD string in the USER'S local day, not a Date.
 * A Date would be interpreted in the server's zone, and "steps on the 23rd"
 * would shift for anyone not sitting in it.
 */
const StepCountSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  date:    { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  steps:   { type: Number, required: true, min: 0 },

  // Which sensor produced it, so a future source (a watch, a manual entry)
  // is distinguishable from the phone's own step counter.
  source:  { type: String, default: 'pedometer' },

  // The device's raw cumulative reading at the time of the last update, kept
  // only for diagnosis when a figure looks wrong.
  raw_device_total: { type: Number, default: null },
}, { timestamps: true });

// One row per user per day; the upsert in the route relies on this.
StepCountSchema.index({ user_id: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('StepCount', StepCountSchema);
