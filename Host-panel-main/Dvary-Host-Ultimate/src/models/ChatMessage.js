const mongoose = require('mongoose');

// A message inside a private Conversation (separate from Community chat and the old Support inbox).
const chatMessageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderRole: { type: String, enum: ['user', 'admin'], required: true },
  text: { type: String, required: true, maxlength: 1000 },
  read: { type: Boolean, default: false }       // read by the OTHER participant
}, { timestamps: true });

chatMessageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
