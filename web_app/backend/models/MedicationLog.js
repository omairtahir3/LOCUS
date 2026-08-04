const mongoose = require('mongoose');

// Shared with Python service — same collection: 'medication_logs'
const MedicationLogSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  medication_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', required: true },

  scheduled_time: { type: Date, required: true },
  taken_at:       { type: Date, default: null },

  status: {
    type: String,
    enum: ['taken', 'missed', 'scheduled', 'snoozed', 'camera_off', 'needs_verification', 'skipped'],
    default: 'scheduled'
  },

  verification_method: {
    type: String,
    enum: ['visual', 'manual', 'caregiver', null],
    default: null
  },

  // Fields populated by the Python camera/AI service
  confidence_score: { type: Number, default: null },  // 0.0 - 1.0
  keyframe_id:      { type: String, default: null },
  camera_used:      { type: Boolean, default: false },

  notes:            { type: String, default: null },
  snoozed_until:    { type: Date, default: null },

  // Reminder tracking
  reminder_count:   { type: Number, default: 0 },
  last_reminded_at: { type: Date, default: null },
  max_reminders:    { type: Number, default: 3 },

  // Caregiver notification tracking
  caregiver_notified: { type: Boolean, default: false },

  // AI Batch-and-Store Pre-generated Messages
  pre_generated_reminder_title:   { type: String, default: null },
  pre_generated_reminder_message: { type: String, default: null },
  pre_generated_missed_title:     { type: String, default: null },
  pre_generated_missed_message:   { type: String, default: null },
  is_flagged:                     { type: Boolean, default: false },

}, { timestamps: true });

MedicationLogSchema.index({ user_id: 1, scheduled_time: -1 });
MedicationLogSchema.index({ user_id: 1, status: 1, scheduled_time: -1 });
MedicationLogSchema.index({ medication_id: 1 });

module.exports = mongoose.model('MedicationLog', MedicationLogSchema, 'medication_logs');