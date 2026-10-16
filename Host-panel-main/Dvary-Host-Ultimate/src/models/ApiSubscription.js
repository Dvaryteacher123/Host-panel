const mongoose = require('mongoose');

// One subscription per customer. It exists ONLY after a payment was confirmed by the payment provider (or an admin activated it).
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  planName: { type: String, default: 'DVARY API PRO' },
  priceTZS: { type: Number, default: 0 },                              // (legacy) kept for old data
  paidAmount: { type: Number, default: 0 },                            // what the customer really paid last time, in his own currency
  paidCurrency: { type: String, default: 'TZS' },
  status: { type: String, enum: ['active', 'expired', 'suspended'], default: 'active', index: true },
  suspended: { type: Boolean, default: false },
  suspendNote: { type: String, default: '', maxlength: 200 },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  payments: { type: [new mongoose.Schema({ order: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder' }, at: { type: Date, default: Date.now }, days: Number, amount: Number, currency: String, source: { type: String, default: 'payment' } }, { _id: false })], default: [] },
  limitOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },   // per-customer limits set by the admin (missing = package default)
  permissionsOverride: { type: [String], default: undefined },          // per-customer permissions (undefined = package default)
  totalRequests: { type: Number, default: 0 },
  serversCreated: { type: Number, default: 0 },
  lastRequestAt: { type: Date, default: null }
}, { timestamps: true });

module.exports = mongoose.model('ApiSubscription', schema);
