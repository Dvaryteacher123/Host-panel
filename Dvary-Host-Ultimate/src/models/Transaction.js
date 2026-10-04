const mongoose = require('mongoose');

const txSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['credit', 'debit', 'refund'], required: true },
  amount: { type: Number, required: true, min: 1 },
  balanceAfter: { type: Number, required: true },
  description: { type: String, default: '' },
  reference: { type: String, required: true, unique: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', txSchema);
