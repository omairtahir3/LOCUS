const mongoose = require('mongoose');

const LocationLogSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  accuracy: { type: Number, default: 0 },
  speed: { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now, required: true }
}, { timestamps: true });

// Index for chronological querying to find latest location quickly
LocationLogSchema.index({ user_id: 1, timestamp: -1 });

module.exports = mongoose.model('LocationLog', LocationLogSchema);
