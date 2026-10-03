const mongoose = require('mongoose');

const serverSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  plan: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan' },
  planName: { type: String, default: '' },
  name: { type: String, required: true, trim: true },
  pteroId: { type: Number, default: null },
  identifier: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'active', 'suspended', 'failed'], default: 'pending' },
  phone: { type: String, default: '' },
  panelUrl: { type: String, default: '' },
  deploymentStatus: { type: String, default: '' },
  panelPassword: { type: String, default: '' },
  deployLog: { type: [String], default: [] },
  paymentOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentOrder', default: null, index: true },
  resources: {
    memory: Number, disk: Number, cpu: Number, databases: Number, backups: Number
  }
}, { timestamps: true });

serverSchema.index({ user: 1, createdAt: -1 });
serverSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('Server', serverSchema);
