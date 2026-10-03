const mongoose = require('mongoose');

// A downloadable ZIP sold (or given away) from the ZIP Shop. The file itself lives on MediaFire; only the link is stored.
const zipSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: '', maxlength: 400 },
  url: { type: String, required: true, maxlength: 600 },            // MediaFire link, never shown before access is allowed
  type: { type: String, enum: ['free', 'vip'], default: 'free', index: true },
  priceTZS: { type: Number, default: 0, min: 0 },                   // VIP price in TZS (converted for other currencies)
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },        // optional fixed price per currency, e.g. { KES: 500 }
  active: { type: Boolean, default: true },
  downloads: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('Zip', zipSchema);
