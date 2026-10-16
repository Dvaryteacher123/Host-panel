const mongoose = require('mongoose');
// A port that belonged to a server which was just deleted / failed / moved. Docker or Wings may still hold it for a while,
// so the site does not hand it to a NEW server for 24 hours.
const schema = new mongoose.Schema({
  node: { type: Number, required: true },
  port: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 }
});
schema.index({ node: 1, port: 1 }, { unique: true });
module.exports = mongoose.model('RecentPort', schema);
