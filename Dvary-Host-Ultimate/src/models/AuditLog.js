const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
  admin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  adminName: { type: String, default: '' },
  action: { type: String, required: true },
  target: { type: String, default: '' },
  detail: { type: String, default: '' },
  ip: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('AuditLog', auditSchema);
