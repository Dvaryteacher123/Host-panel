const mongoose = require('mongoose');
// A host port that Docker refused ("port is already allocated"). The site never gives it to a new server again.
const schema = new mongoose.Schema({
  node: { type: Number, required: true },
  port: { type: Number, required: true },
  ip: { type: String, default: '' },
  reason: { type: String, default: '', maxlength: 200 },
  createdAt: { type: Date, default: Date.now }
});
schema.index({ node: 1, port: 1 }, { unique: true });
module.exports = mongoose.model('BadPort', schema);
