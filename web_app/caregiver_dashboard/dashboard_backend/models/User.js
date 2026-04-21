const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  email:        { type: String, required: true, unique: true, lowercase: true },
  password:     { type: String, required: true },
  role:         { type: String, enum: ['user', 'elderly', 'caregiver', 'admin'], default: 'user' },

  // For elderly users — list of caregiver user IDs who can view their data
  caregiver_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // For caregivers — list of users they are monitoring
  monitoring_users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

  // Notification preferences
  notification_prefs: {
    email:           { type: Boolean, default: true },
    sms:             { type: Boolean, default: false },
    push:            { type: Boolean, default: true },
    missed_dose:     { type: Boolean, default: true },
    emergency:       { type: Boolean, default: true },
  },

  phone:        { type: String, default: null },
  is_active:    { type: Boolean, default: true },
}, { timestamps: true });

// Hash password before saving
UserSchema.pre('save', async function () {
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