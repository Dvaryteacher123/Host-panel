const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  kind: { type: String, enum: ['server', 'admin'], default: 'server', index: true },
  description: { type: String, default: '', maxlength: 300 },
  coins: { type: Number, default: 0, min: 0 },    // legacy - plans are sold with money now
  periods: { type: [new mongoose.Schema({ days: { type: Number, required: true, min: 1 }, free: { type: Boolean, default: false }, coins: { type: Number, default: 0, min: 0 }, priceTZS: { type: Number, default: 0, min: 0 }, prices: { type: mongoose.Schema.Types.Mixed, default: {} } }, { _id: false })], default: [] },   // durations + prices; empty = one-off price, no expiry
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },   // fixed price per currency set by the admin, e.g. { KES: 2500, UGX: 70000 }; missing = converted from TZS
  priceTZS: { type: Number, default: 0, min: 0 },   // money price set by the admin; 0 = automatic (coins x coin price)
  memory: { type: Number, default: 0, validate: { validator(v) { return this.kind === 'admin' || v >= 64; }, message: 'memory must be >= 64' } },
  disk: { type: Number, default: 0, validate: { validator(v) { return this.kind === 'admin' || v >= 64; }, message: 'disk must be >= 64' } },
  cpu: { type: Number, default: 0, min: 0 },
  databases: { type: Number, default: 0, min: 0 },
  backups: { type: Number, default: 0, min: 0 },
  nestId: { type: Number, default: null },
  eggId: { type: Number, default: null },
  dockerImage: { type: String, default: '' },
  startup: { type: String, default: '' },
  eggName: { type: String, default: '' },
  imageLabel: { type: String, default: '' },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
