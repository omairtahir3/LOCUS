const mongoose = require('mongoose');

const userItemSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  item_name: {
    type: String,
    required: true
  },
  item_embeddings: {
    type: [[Number]],
    default: []
  },
  // Which enrolment PHOTO each embedding came from. Every photo is expanded
  // across lighting and angle before embedding, so the gallery holds several
  // vectors per photo. Judging how coherent a gallery is only means something
  // between different photos: variants of one photo are near identical by
  // construction and would report every gallery as healthy. Empty on items
  // enrolled before augmentation existed, where one embedding is one photo.
  embedding_sources: {
    type: [Number],
    default: []
  },
  representative_image: {
    type: String,
    default: null
  },
  enrolled_by: {
    type: String,
    enum: ['user', 'elderly', 'caregiver'],
    required: true
  },
  is_active: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

// Index to quickly find items for a user
userItemSchema.index({ user_id: 1 });

module.exports = mongoose.model('UserItem', userItemSchema);
