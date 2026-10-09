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
  // How coherent this gallery is, computed ONCE when it is built.
  //
  // It used to be recomputed on every list request: an O(n^2) cosine over 150
  // vectors of 576 dimensions, per item, which is 11,175 pairs each. Measured
  // at 232 ms for one item, and the list endpoint did it for every item on
  // every call -- about 530 ms to answer a request whose database query takes
  // 21 ms. A gallery only changes when it is enrolled, so the answer does too.
  gallery: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  // What the object detector actually calls this item, measured on its own
  // enrolment photos. Objects365 has no earbuds class and boxes their case as
  // "Mouse"; comparing that label to the NAME found no overlap and raised the
  // match bar to 0.85, which those earbuds could never clear. The label is not
  // an opinion about identity, only what this detector calls this shape.
  detector_class: {
    type: String,
    default: null,
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
