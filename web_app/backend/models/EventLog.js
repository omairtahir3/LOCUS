const mongoose = require('mongoose');

const eventLogSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  event_type: {
    type: String,
    enum: ['medication', 'medication_intake', 'activity', 'social', 'object', 'social_interaction', 'unknown_face'],
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  confidence: {
    type: Number,
    min: 0,
    max: 1,
    default: 1.0
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
    // Will hold:
    // { medication_name: "Panadol" } 
    // { action: "left_house", location: "doorway" }
    // { person: "John Doe", relation: "son" }
    // { object: "keys", gps: [lat, lng] }
  },
  keyframe_id: {
    type: String,
    // Links to MedicationEvidenceStorage or KeyframeStorage UUID
  },
  retention_until: {
    type: Date,
    default: null
  },
  is_flagged: {
    type: Boolean,
    default: false
  },
  person_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Relationship',
    default: null
  },
  verification_status: {
    type: String,
    enum: ['pending', 'confirmed', 'rejected'],
    default: 'pending'
  },
  pending_notification: {
    type: Boolean,
    default: false
  }
}, { timestamps: true });

// Index for chronological querying for the Behavioral Pattern Learning (14-day baseline)
eventLogSchema.index({ user_id: 1, timestamp: -1 });
eventLogSchema.index({ event_type: 1 });

module.exports = mongoose.model('EventLog', eventLogSchema);
