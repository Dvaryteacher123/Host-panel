const mongoose = require('mongoose');

// A customer's API key. Only the SHA-256 hash is stored - the real key is shown once when it is created.
const apiKeySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  paymentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder', default: null, index: true },
  name: { type: String, default: 'My app', trim: true, maxlength: 40 },        // the customer's app name
  appUrl: { type: String, default: '', trim: true, maxlength: 200 },         // website / link of the app
  appDescription: { type: String, default: '', trim: true, maxlength: 200 }, // what the app does
  prefix: { type: String, default: '' },                    // first characters, so the customer can recognise the key
  hash: { type: String, required: true, unique: true },
  revoked: { type: Boolean, default: false, index: true },
  uses: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
  lastIp: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('ApiKey', apiKeySchema);
