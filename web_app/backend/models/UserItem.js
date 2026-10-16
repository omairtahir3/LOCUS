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
  // Sightings the camera was sure enough about to learn from.
  //
  // Enrolment photos are taken with a phone in good light, close up: lightness
  // around 150 on this wearer's items. The same belongings through the chest
  // camera arrive at 48-79. The gallery was built in one world and asked about
  // another, and that gap is what matching was losing to. Letting a confident
  // sighting join the gallery teaches it THIS camera: 23 of 41 real crops
  // matched correctly before, 33 after, with no new wrong matches.
  //
  // Kept separate from item_embeddings on purpose. Adoption is judged against
  // the enrolment vectors ALONE, so an adopted vector can never vouch for the
  // next candidate and one mistake cannot breed. The textureless-item floor is
  // likewise computed on enrolment alone, or these deliberately varied crops
  // would drag the internal similarity down and strip the floor off the items
  // that most need it. Clearing this array returns the item to how it was
  // enrolled, without re-enrolling it.
  adopted_embeddings: {
    type: [[Number]],
    default: []
  },
  // Provenance for each adopted vector: when, how well it matched enrolment,
  // and which frame it came from, so a gallery that drifts can be explained
  // rather than guessed at.
  adopted_meta: {
    type: [mongoose.Schema.Types.Mixed],
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
  // The typical shape of this item's detection box, width per unit height.
  // Two small dark textureless belongings embed almost identically -- one
  // wearer's phone sat 0.017 from their earbuds -- but their outlines do not:
  // phone 0.50-1.20, earbuds case 0.82-2.46. Used only to break a tie the
  // appearance could not, never to claim a match on its own.
  // {median, lo, hi, n} -- the RANGE, not a single number. A phone in portrait
  // and the same phone in landscape differ fourfold in aspect ratio, so a
  // median alone would let a tight-shaped item steal its sightings. Shape is
  // only ever consulted when two items' ranges do not overlap.
  box_aspect: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  representative_image: {
    type: String,
    default: null
  },
  // Every enrolment photograph, not just the first.
  //
  // Enrolment used to embed fifteen photographs and keep one. The vectors it
  // kept are MobileNet-space numbers and cannot be converted, so when a second
  // model was added to check matches it had a single photograph to learn each
  // belonging from -- and a verifier taught one bright top-down photo of a
  // teal case on a desk duly refused every dark side-on view the camera
  // actually produced, at 0.47 to 0.53 against a 0.55 bar.
  //
  // Fifteen 240x320 JPEGs is about 200 KB, which is nothing against being
  // unable to adopt a better model without asking the wearer to photograph
  // everything they own again.
  enrollment_images: {
    type: [String],
    default: []
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
