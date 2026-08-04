const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['user', 'elderly', 'caregiver', 'admin'], default: 'user' },
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

  phone:        { type: String, default: null },
  camera_stream_url: { type: String, default: null },  // RTSP/RTMP camera URL for this elderly user's AI pipeline
  
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