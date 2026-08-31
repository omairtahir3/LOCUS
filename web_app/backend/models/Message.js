const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  is_emergency_related: { type: Boolean, default: false }
});

// Index for fast retrieval of chat history between two users
MessageSchema.index({ sender_id: 1, recipient_id: 1, timestamp: -1 });

module.exports = mongoose.model('Message', MessageSchema);
