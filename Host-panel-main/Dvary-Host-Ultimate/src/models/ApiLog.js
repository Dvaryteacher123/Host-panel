const mongoose = require('mongoose');
// one line per API request (kept 30 days)
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiSubscription', index: true },
  keyPrefix: { type: String, default: '' },
  method: String, path: String, status: Number, ms: Number,
  ip: { type: String, default: '' },
  error: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30, index: true }
});
module.exports = mongoose.model('ApiLog', schema);
