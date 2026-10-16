const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  role: { type: String, default: 'user' },
  text: { type: String, required: true, maxlength: 500 }
}, { timestamps: true });

module.exports = mongoose.model('Message', messageSchema);
