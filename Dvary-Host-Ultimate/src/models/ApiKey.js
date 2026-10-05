const mongoose = require('mongoose');

// A customer's API key. Only the SHA-256 hash is stored - the real key is shown once, when it is generated.
const apiKeySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiSubscription', index: true },
  name: { type: String, default: 'My app', trim: true, maxlength: 40 },
  appUrl: { type: String, default: '', trim: true, maxlength: 200 },
  appDescription: { type: String, default: '', trim: true, maxlength: 200 },
  prefix: { type: String, default: '' },                    // e.g. dvary_live_ab12 - to recognise a key
  hash: { type: String, required: true, unique: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active', index: true },
  revoked: { type: Boolean, default: false },
  revokedAt: { type: Date, default: null },
  uses: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
  lastIp: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('ApiKey', apiKeySchema);
