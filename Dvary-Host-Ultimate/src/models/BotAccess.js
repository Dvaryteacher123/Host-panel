const mongoose = require('mongoose');

// "This customer unlocked this VIP bot" (one row per customer + bot).
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  bot: { type: mongoose.Schema.Types.ObjectId, ref: 'BotZip', required: true },
  via: { type: String, enum: ['coins', 'money', 'admin'], default: 'coins' },
  paymentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder', default: null }
}, { timestamps: true });

schema.index({ user: 1, bot: 1 }, { unique: true });

module.exports = mongoose.model('BotAccess', schema);
