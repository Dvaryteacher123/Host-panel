const mongoose = require('mongoose');

// A ready-made bot (ZIP file) the admin shares as a download link (e.g. MediaFire).
// FREE = anyone can download. VIP = the customer must pay (coins or money) once to unlock the download.
const botZipSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: '', trim: true, maxlength: 1500 },
  type: { type: String, enum: ['free', 'vip'], default: 'free', index: true },
  link: { type: String, required: true, trim: true, maxlength: 700 },       // download URL - never sent to the browser until unlocked
  imageUrl: { type: String, default: '', trim: true, maxlength: 700 },
  videoUrl: { type: String, default: '', trim: true, maxlength: 700 },
  coins: { type: Number, default: 0, min: 0 },                               // VIP price in coins
  priceTZS: { type: Number, default: 0, min: 0 },                            // VIP price in money (0 = coins x coin price)
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },                // optional fixed price per currency
  active: { type: Boolean, default: true },
  downloads: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('BotZip', botZipSchema);
