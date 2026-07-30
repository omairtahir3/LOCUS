const mongoose = require('mongoose');

// General keyframe metadata — replaces the .json sidecar files
// that were previously written next to .jpg images on disk.
const keyframeMetaSchema = new mongoose.Schema({
  keyframe_id: {
    type: String,
    required: true,
    unique: true
  },
  user_id: {
    type: String,
    required: true
  },
  timestamp: {
    type: String,   // ISO string from the AI pipeline
  },
  saved_at: {
    type: Date,
    default: Date.now
  },
  motion_score: {
    type: Number,
    default: 0
  },
  blur_score: {
    type: Number,
    default: 0
  },
  width: Number,
  height: Number,
  // Medication detection fields (set by tag_as_medication_detected)
  medication_detected: {
    type: Boolean,
    default: false
  },
  detection_confidence: {
    type: Number,
    default: 0
  },
  detection_status: String,
  medication_name: String,
  medication_id: String,
  detected_at: Date
}, { timestamps: true });

keyframeMetaSchema.index({ user_id: 1, saved_at: -1 });
keyframeMetaSchema.index({ medication_detected: 1 });

module.exports = mongoose.model('KeyframeMeta', keyframeMetaSchema);
