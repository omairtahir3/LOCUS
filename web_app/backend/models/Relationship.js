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
  }
}, { timestamps: true });

// Index to quickly find relationships for a user
relationshipSchema.index({ user_id: 1 });

module.exports = mongoose.model('Relationship', relationshipSchema);
