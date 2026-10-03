const mongoose = require('mongoose');

const relationshipSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  person_name: {
    type: String,
    required: true
  },
  relationship_type: {
    type: String,
    default: ''
  },
  face_embedding: {
    type: [Number],
    required: true
  },
  face_embeddings: {
    type: [[Number]],
    default: []
  },
  representative_keyframe_id: {
    type: String,
    default: null
  },
  confirmed_by: {
    type: String,
    enum: ['user', 'elderly', 'caregiver'],
    required: true
  },
  pending_notification: {
    type: Boolean,
    default: false
  },
  // The conversation heard the first time this person appeared, while they
  // were still an unknown face. Declared because mongoose drops undeclared
  // paths silently under its default strict mode, so writing it without this
  // would have looked like it worked and saved nothing.
  //
  // The summary is kept, not the transcript: the transcript expires on the
  // keyframe clock and is only how the summary was obtained.
  first_interaction: {
    event_id: { type: mongoose.Schema.Types.ObjectId, ref: 'EventLog' },
    at: Date,
    summary: String,
    topics: String
  }
}, { timestamps: true });

// Index to quickly find relationships for a user
relationshipSchema.index({ user_id: 1 });

module.exports = mongoose.model('Relationship', relationshipSchema);
