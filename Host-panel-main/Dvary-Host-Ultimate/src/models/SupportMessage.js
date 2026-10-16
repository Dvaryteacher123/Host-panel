const mongoose = require('mongoose');

// One conversation thread per user. `from` says who wrote the message.
const supportSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  from: { type: String, enum: ['user', 'admin'], required: true },
  text: { type: String, required: true, maxlength: 1000 },
  readByAdmin: { type: Boolean, default: false },
  readByUser: { type: Boolean, default: false }
}, { timestamps: true });

module.exports = mongoose.model('SupportMessage', supportSchema);
