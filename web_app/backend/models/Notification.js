const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  // Who receives it
  recipient_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Who it is about (e.g. the elderly user)
  subject_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  type: {
    type: String,
    enum: [
      'missed_dose',        // medication missed
      'dose_reminder',      // upcoming dose reminder
      'dose_confirmed',     // dose taken confirmed by camera
      'skipped_medicine',   // user skipped one or more medicines at a scheduled time
      'emergency',          // I'm Lost triggered
      'status_check',       // caregiver requested status check
      'caregiver_message',  // message from caregiver
      'system',             // general system alert
    ],
    required: true
  },

  title:    { type: String, required: true },
  message:  { type: String, required: true },

  // Reference to the related medication/log if applicable
  medication_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Medication', default: null },
  medication_log_id: { type: mongoose.Schema.Types.ObjectId, ref: 'MedicationLog', default: null },

  // Delivery status per channel
  delivery: {
    push:  { sent: Boolean, sent_at: Date, failed: Boolean },
    email: { sent: Boolean, sent_at: Date, failed: Boolean },
    sms:   { sent: Boolean, sent_at: Date, failed: Boolean },
  },

  is_read:      { type: Boolean, default: false },
  read_at:      { type: Date, default: null },
  is_dismissed: { type: Boolean, default: false },

  // For escalation — if not acknowledged after X minutes, escalate
  requires_acknowledgement: { type: Boolean, default: false },
  acknowledged_at:          { type: Date, default: null },
  escalated:                { type: Boolean, default: false },
  escalated_at:             { type: Date, default: null },

}, { timestamps: true });

NotificationSchema.index({ recipient_id: 1, createdAt: -1 });
NotificationSchema.index({ recipient_id: 1, is_read: 1 });
NotificationSchema.index({ recipient_id: 1, is_dismissed: 1 });

module.exports = mongoose.model('Notification', NotificationSchema);