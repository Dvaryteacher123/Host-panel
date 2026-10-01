const mongoose = require('mongoose');

const planSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, default: '', maxlength: 300 },
  coins: { type: Number, required: true, min: 1 },
  memory: { type: Number, required: true, min: 64 },
  disk: { type: Number, required: true, min: 64 },
  cpu: { type: Number, required: true, min: 0 },
  databases: { type: Number, default: 0, min: 0 },
  backups: { type: Number, default: 0, min: 0 },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Plan', planSchema);
