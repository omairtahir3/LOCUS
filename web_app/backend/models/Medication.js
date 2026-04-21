const mongoose = require('mongoose');

// Shared with Python service — same collection name: 'medications'
const MedicationSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.Mixed, required: true },  // Mixed: accepts both string (Flutter) and ObjectId

  name:             { type: String, required: true },
  dosage:           { type: String, required: true },       // e.g. "500mg"
  frequency:        {
    type: String,
    enum: ['daily', 'twice_daily', 'three_times', 'weekly', 'as_needed', 'custom'],
    required: true
  },
  scheduled_times:  [{ type: String }],                    // e.g. ["08:00", "20:00"]
  days_of_week:     [{ type: Number }],                    // 0=Mon, 6=Sun
  instructions:     { type: String, default: null },
  start_date:       { type: Date, required: true },
  end_date:         { type: Date, default: null },

  snooze_duration_minutes:    { type: Number, default: 10 },
  caregiver_notify_on_miss:   { type: Boolean, default: true },
  is_active:                  { type: Boolean, default: true },
}, { timestamps: true });

MedicationSchema.index({ user_id: 1 });

module.exports = mongoose.model('Medication', MedicationSchema, 'medications');