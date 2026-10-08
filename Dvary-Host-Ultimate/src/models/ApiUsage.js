const mongoose = require('mongoose');
// requests per subscription per day (for the daily limit and the statistics)
const schema = new mongoose.Schema({
  subscription: { type: mongoose.Schema.Types.ObjectId, ref: 'ApiSubscription', required: true },
  day: { type: String, required: true },       // YYYY-MM-DD (UTC)
  requests: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 120 }
});
schema.index({ subscription: 1, day: 1 }, { unique: true });
module.exports = mongoose.model('ApiUsage', schema);
