const mongoose = require('mongoose');

// A gift the admin hands out (WhatsApp, in person...). The customer types the code on the Deploy page and receives coins.
// Coins are NOT sold anywhere: they exist only as gifts, and one coin deploys a bot for free (see "Offer coins" of a bot).
const schema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true },
  coins: { type: Number, required: true, min: 1 },
  maxUses: { type: Number, default: 1, min: 1 },               // how many different customers can use it
  usedBy: { type: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, at: { type: Date, default: Date.now } }], default: [] },
  note: { type: String, default: '', maxlength: 120 },
  expiresAt: { type: Date, default: null },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true });

module.exports = mongoose.model('GiftCode', schema);
