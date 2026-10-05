const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['user', 'elderly', 'caregiver'], default: 'user' },
  picture:      { type: String, default: null },
  profile_picture: { type: String, default: null },
  fcm_token:       { type: String, default: null },

  // For elderly users — list of caregiver user IDs who can view their data
  caregiver_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // For caregivers — list of users they are monitoring
  monitoring_users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Notification preferences
  notification_prefs: {
    email:           { type: Boolean, default: true },
    push:            { type: Boolean, default: true },
    missed_dose:     { type: Boolean, default: true },
    emergency:       { type: Boolean, default: true },
  },

  // ── Privacy (Module A FE-4 and FE-5, Module 10 FE-3) ──────────────────────
  //
  // Three states, not a boolean, because "stop recording" and "stop showing me
  // recognisable pictures" are different needs and the wearer should be able to
  // pick. 'blur' keeps the day's record while making every stored frame
  // unreadable; 'paused' keeps nothing at all.
  //
  // sensitive_rooms is the washroom rule. The scene classifier already knows a
  // bathroom (Toilet, Bathtub, Toothbrush, Toilet Paper), and the moment it
  // says so the capture goes dead and the frames already written from that room
  // are destroyed -- classification happens after a frame reaches disk, so
  // without the retroactive half the first washroom frames would survive the
  // very feature meant to prevent them.
  //
  // It defaults to ['bathroom'] rather than empty. A privacy feature that
  // protects nobody until they configure it protects nobody.
  privacy: {
    mode:            { type: String, enum: ['off', 'blur', 'paused'], default: 'off' },
    mode_set_at:     { type: Date, default: null },
    sensitive_rooms: { type: [String], default: () => ['bathroom'] },
    // Places, for the same purpose: a clinic, a neighbour's house.
    sensitive_places: [{
      label:    { type: String, default: '' },
      lat:      { type: Number, required: true },
      lng:      { type: Number, required: true },
      radius_m: { type: Number, default: 50 },
    }],
    // What the pipeline decided, written back so the UI can say WHY capture is
    // dead right now rather than looking broken. Set by the AI backend.
    auto_dead_until:  { type: Date, default: null },
    auto_dead_reason: { type: String, default: null },
  },

  phone:        { type: String, default: null },
  camera_stream_url: { type: String, default: null },  // RTSP/RTMP camera URL for this elderly user's AI pipeline
  // Where the outdoor item checks measure "away from home" from (Core FE-12).
  // Set in Settings, or inferred from where the phone spends the small hours
  // when it has not been (utils/outdoor.js resolveHome). `inferred` records
  // which, so the UI can show it as a guess and invite a correction.
  home_location: {
    lat: { type: Number },
    lng: { type: Number },
    address: { type: String },
    inferred: { type: Boolean, default: false }
  },
  
  // AI Confidence Thresholds Override
  confidence_thresholds: {
    medication_intake: {
      auto_verify: { type: Number, default: 0.85 },
      confirm: { type: Number, default: 0.70 },
      analyzed_events_count: { type: Number, default: 0 },
      last_adjusted_at: { type: Date, default: null }
    },
    unknown_face: {
      auto_verify: { type: Number, default: 0.85 },
      confirm: { type: Number, default: 0.70 },
      analyzed_events_count: { type: Number, default: 0 },
      last_adjusted_at: { type: Date, default: null }
    }
  },
  is_active:    { type: Boolean, default: true },
  emergency_status: { type: Boolean, default: false },
  last_emergency_time: { type: Date, default: null },
}, { timestamps: true });

const os = require('os');

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Hash password before saving
UserSchema.pre('save', async function () {
  // Automatically generate RTMP link for new users
  if (this.isNew && !this.camera_stream_url) {
    this.camera_stream_url = `rtsp://locus_ai:LocusRead2026@127.0.0.1:8554/live/${this._id}`;
  }

  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

// Compare password method
UserSchema.methods.comparePassword = async function (plain) {
  return bcrypt.compare(plain, this.password);
};

// Never return password in JSON responses
UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('User', UserSchema);