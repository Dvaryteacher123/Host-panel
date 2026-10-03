const mongoose = require('mongoose');

// Proof that a customer bought a VIP ZIP (created automatically after the payment is confirmed).
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  zip: { type: mongoose.Schema.Types.ObjectId, ref: 'Zip', required: true },
  paymentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder', default: null }
}, { timestamps: true });

schema.index({ user: 1, zip: 1 }, { unique: true });

module.exports = mongoose.model('ZipAccess', schema);
