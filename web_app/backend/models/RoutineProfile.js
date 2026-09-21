const mongoose = require('mongoose');

/**
 * One document per user: what this person usually does, and when.
 *
 * Each signal is a pair of 24-slot histograms (weekday / weekend) counting how
 * many distinct DAYS the signal occurred in that hour, plus how many days of
 * that type were observed at all. "Expected" at a slot means
 * days_seen / days_observed >= EXPECTED_RATIO. Kept deliberately simple: it is
 * inspectable (print the grid, compare to what the person actually did), it
 * works on sparse data, and it can be replaced by something heavier without
 * touching the monitor that consumes it.
 */
const histogramSchema = new mongoose.Schema({
  weekday: { type: [Number], default: () => new Array(24).fill(0) },
  weekend: { type: [Number], default: () => new Array(24).fill(0) },
}, { _id: false });

const signalSchema = new mongoose.Schema({
  key:       { type: String, required: true },   // "scene:kitchen", "item:<id>", "medication"
  label:     { type: String, default: '' },      // human name, e.g. "Car Keys"
  hist:      { type: histogramSchema, default: () => ({}) },
  total:     { type: Number, default: 0 },       // raw event count in baseline
  // for scene signals: typical session length in minutes
  mean_duration_min: { type: Number, default: null },
  // for item signals: which room the item is usually in
  rooms:     { type: Map, of: Number, default: () => ({}) },
}, { _id: false });

const routineProfileSchema = new mongoose.Schema({
  user_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  role:      { type: String, enum: ['user', 'elderly', 'caregiver'], required: true },
  built_at:  { type: Date, default: Date.now },
  baseline_days: { type: Number, default: 30 },
  // distinct days with ANY signal, per day type. Denominator for "expected".
  days_observed: {
    weekday: { type: Number, default: 0 },
    weekend: { type: Number, default: 0 },
  },
  signals:   { type: [signalSchema], default: [] },
}, { timestamps: true });

// user_id is unique above, which already creates the index.

module.exports = mongoose.model('RoutineProfile', routineProfileSchema, 'routine_profiles');
