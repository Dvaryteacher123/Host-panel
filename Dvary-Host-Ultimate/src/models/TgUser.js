const mongoose = require('mongoose');

// One Telegram customer linked to a normal site account (created automatically on /start).
const schema = new mongoose.Schema({
  tgId: { type: String, required: true, unique: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username: { type: String, default: '' },
  lastPhone: { type: String, default: '' },
  lang: { type: String, enum: ['sw', 'en'], default: 'sw' },
  state: { type: mongoose.Schema.Types.Mixed, default: null }   // small conversation state, e.g. { step: 'name', kind: 'server', plan: '...' }
}, { timestamps: true });

module.exports = mongoose.model('TgUser', schema);
