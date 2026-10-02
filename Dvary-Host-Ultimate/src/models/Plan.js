const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  kind: { type: String, enum: ['server', 'admin'], default: 'server', index: true },
  description: { type: String, default: '', maxlength: 300 },
  coins: { type: Number, required: true, min: 1 },
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
