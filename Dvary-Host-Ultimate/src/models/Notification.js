const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 80 },
  message: { type: String, required: true, trim: true, maxlength: 600 },
  type: { type: String, enum: ['info', 'success', 'warning'], default: 'info' },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

notificationSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
