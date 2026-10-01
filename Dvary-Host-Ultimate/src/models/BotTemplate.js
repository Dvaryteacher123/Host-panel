const mongoose = require('mongoose');

const botSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 60 },
  description: { type: String, default: '', maxlength: 300 },
  nestId: { type: Number, default: null },
  eggId: { type: Number, default: null },
  startup: { type: String, default: '' },
  dockerImage: { type: String, default: '' },
  imageUrl: { type: String, default: '' },     // picture shown to customers on the deploy page
  phoneVar: { type: String, default: '' },     // egg variable that holds the owner's phone number (pairing)
  archivePath: { type: String, default: '' }, // private ZIP path managed by the admin
  archiveFilename: { type: String, default: '' },
  environment: { type: mongoose.Schema.Types.Mixed, default: {} },
  active: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('BotTemplate', botSchema);
