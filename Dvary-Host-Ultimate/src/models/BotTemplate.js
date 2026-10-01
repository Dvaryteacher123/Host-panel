const mongoose = require('mongoose');

const botSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, default: '', maxlength: 300 },
  eggId: { type: Number, default: null },
  startup: { type: String, default: '' },
  dockerImage: { type: String, default: '' },
  gitUrl: { type: String, default: '' },      // set by admin only; never shown to customers
  gitBranch: { type: String, default: 'main' },
  environment: { type: mongoose.Schema.Types.Mixed, default: {} },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('BotTemplate', botSchema);
