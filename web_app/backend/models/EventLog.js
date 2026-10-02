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
  },
  location: {
    lat: { type: Number, required: false },
    lng: { type: Number, required: false }
  }
}, { timestamps: true });

// Index for chronological querying for the Behavioral Pattern Learning (14-day baseline)
eventLogSchema.index({ user_id: 1, timestamp: -1 });
eventLogSchema.index({ event_type: 1 });

// The routine monitor's own access patterns. It runs every 2 minutes for every
// monitored user, and almost every query it makes narrows by details.action or
// event_type before sorting on time. With only {user_id, timestamp} to work
// with, Mongo had to walk that user's whole history and filter in memory:
// measured, 1234 documents examined to return 13, a ratio of 95, and one full
// monitor pass over 21 users cost 1598 ms. That is survivable at 1429 events
// and is not survivable as the collection grows, because the work per user
// grows with the number of events rather than with the number of matches.
//
// Both put the equality fields first and the sort field last, so a query can
// seek straight to its range and read it in order.
eventLogSchema.index({ user_id: 1, 'details.action': 1, timestamp: -1 });
eventLogSchema.index({ user_id: 1, event_type: 1, timestamp: -1 });

module.exports = mongoose.model('EventLog', eventLogSchema);
