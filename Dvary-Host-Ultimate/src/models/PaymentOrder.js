const mongoose = require('mongoose');

// One automatic payment made through FimiPay (a server purchase or a coin top-up).
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, enum: ['server', 'coins'], required: true },

  // what is being bought
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', default: null },
  planName: { type: String, default: '' },
  serverName: { type: String, default: '' },
  coins: { type: Number, default: 0 },            // coins credited (coins) or plan value in coins (server)

  // money
  country: { type: String, default: 'TZ' },
  currency: { type: String, default: 'TZS' },
  amount: { type: Number, required: true, min: 1 },
  method: { type: String, enum: ['mobile', 'card'], default: 'mobile' },
  phone: { type: String, default: '' },

  // FimiPay
  orderId: { type: String, default: '', index: true },
  gatewayUrl: { type: String, default: '' },
  remoteStatus: { type: String, default: '' },
  transId: { type: String, default: '' },
  channel: { type: String, default: '' },
  environment: { type: String, default: '' },
  lastCheckAt: { type: Date, default: null },
  error: { type: String, default: '' },

  // our state machine: creating -> pending -> paid (-> fulfilled) | failed | cancelled | expired
  status: { type: String, enum: ['creating', 'pending', 'paid', 'failed', 'cancelled', 'expired'], default: 'creating', index: true },
  paidAt: { type: Date, default: null },
  fulfilled: { type: Boolean, default: false },
  fulfillAt: { type: Date, default: null },       // claim marker, so a payment is delivered only once
  fulfilledAt: { type: Date, default: null },
  server: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', default: null },
  note: { type: String, default: '' }
}, { timestamps: true });

schema.index({ orderId: 1 }, { sparse: true });
schema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('PaymentOrder', schema);
