const mongoose = require('mongoose');

// A private offer an admin gives to ONE customer (chosen by email): a plan at a special price,
// payable with coins or with money, optionally with free gift coins credited when the offer is created.
const offerSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  planName: { type: String, default: '' },
  coins: { type: Number, default: 0, min: 0 },                       // offer price in coins (0 = free)
  priceTZS: { type: Number, default: 0, min: 0 },                    // offer price in money (0 = coins x coin price)
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },       // optional fixed price per currency
  serverDays: { type: Number, default: 0, min: 0 },                  // how long the server lasts (0 = never expires)
  giftCoins: { type: Number, default: 0, min: 0 },                   // coins credited to the customer when the offer was created
  note: { type: String, default: '', maxlength: 200 },
  expiresAt: { type: Date, default: null },
  status: { type: String, enum: ['active', 'used', 'cancelled'], default: 'active', index: true },
  usedAt: { type: Date, default: null },
  usedWith: { type: String, enum: ['', 'coins', 'money'], default: '' },
  server: { type: mongoose.Schema.Types.ObjectId, ref: 'Server', default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

offerSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model('Offer', offerSchema);
