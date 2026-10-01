const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
  planName: { type: String, default: '' },
  bot: { type: mongoose.Schema.Types.ObjectId, ref: 'BotTemplate', default: null },
  name: { type: String, required: true, trim: true },
  pteroId: { type: Number, default: null },
  identifier: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'active', 'suspended', 'failed'], default: 'pending' },
  phone: { type: String, default: '' },
  panelUrl: { type: String, default: '' },
  githubRepo: { type: String, default: '' },
  githubBranch: { type: String, default: 'main' },
  deploymentStatus: { type: String, default: '' },
  resources: {
    memory: Number, disk: Number, cpu: Number, databases: Number, backups: Number
  }
}, { timestamps: true });

module.exports = mongoose.model('Server', serverSchema);
