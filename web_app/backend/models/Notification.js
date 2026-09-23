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
      'camera_off_alert',   // camera turned off during medication window
      // routine learning (see utils/routineMonitor.js)
      'routine_medication_gap',  // N consecutive days with no verified dose   (to caregivers)
      'routine_inactivity',      // camera on, no movement for hours           (to caregivers)
      'routine_camera_off',      // no frames for hours during waking time     (to caregivers)
      'routine_deviation',       // expected scene not seen at its usual time  (to caregivers)
      'routine_left_behind',     // enrolled item left in the room just exited (to user)
      'routine_habitual_item',   // item usually carried at this hour, absent  (to user)
      'routine_item_lost',           // enrolled item left behind outdoors        (to user, ack required)
      'routine_item_lost_escalated', // user did not acknowledge; GPS + keyframe   (to caregivers)
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

  // Last line of defence against the same alert being written twice. Callers
  // that can name the exact event ("this log, this reminder number, this
  // recipient") pass a dedup_key and the unique index below rejects a repeat,
  // whichever process or overlapping cron pass got there second.
  //
  // Notifications with no natural key leave the field ABSENT, not null: a
  // sparse unique index skips missing fields but still indexes explicit
  // nulls, so `default: null` plus sparse makes every keyless notification
  // collide with the previous one. The index below is partial on $type
  // 'string', which is correct whichever way the field is left.
  dedup_key:    { type: String, default: undefined },

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
NotificationSchema.index({ dedup_key: 1 }, {
  unique: true,
  partialFilterExpression: { dedup_key: { $type: 'string' } },
});

module.exports = mongoose.model('Notification', NotificationSchema);