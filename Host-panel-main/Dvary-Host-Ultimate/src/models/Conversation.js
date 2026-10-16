const mongoose = require('mongoose');

// Private conversation between ONE user and ONE admin (the admin the user picked).
// Exactly one document per (user, admin) pair - enforced by the unique index below.
const conversationSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  lastMessage: { type: String, default: '' },
  lastMessageAt: { type: Date, default: null },
  lastSender: { type: String, enum: ['user', 'admin', ''], default: '' },
  unreadByUser: { type: Number, default: 0, min: 0 },
  unreadByAdmin: { type: Number, default: 0, min: 0 }
}, { timestamps: true });

conversationSchema.index({ user: 1, admin: 1 }, { unique: true });
conversationSchema.index({ admin: 1, updatedAt: -1 });
conversationSchema.index({ user: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
