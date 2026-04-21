const mongoose = require('mongoose');

// Shared with Python service — same collection: 'medication_logs'
const MedicationLogSchema = new mongoose.Schema({
  user_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  medication_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', required: true },

  scheduled_time: { type: Date, required: true },
  taken_at:       { type: Date, default: null },

  status: {
    type: String,
    enum: ['taken', 'missed', 'scheduled', 'snoozed', 'skipped', 'needs_verification'],
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

  notes:            { type: String, default: null },
  snoozed_until:    { type: Date, default: null },

}, { timestamps: true });

MedicationLogSchema.index({ user_id: 1, scheduled_time: -1 });
MedicationLogSchema.index({ medication_id: 1 });

module.exports = mongoose.model('MedicationLog', MedicationLogSchema, 'medication_logs');