const mongoose = require('mongoose');

// Single document (key: 'main') holding the site-wide settings.
const DEFAULTS = {
  siteName: 'DVARY HOST', supportLink: '', panelUrl: '', paymentInfo: '',
  maintenance: false, registrationOpen: true,
  announcement: { text: '', type: 'info', active: false }
};

const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'main' },
  siteName: { type: String, default: DEFAULTS.siteName },
  supportLink: { type: String, default: '' },
  panelUrl: { type: String, default: '' },
  paymentInfo: { type: String, default: '' },
  maintenance: { type: Boolean, default: false },
  registrationOpen: { type: Boolean, default: true },
  announcement: {
    text: { type: String, default: '' },
    type: { type: String, default: 'info' },
    active: { type: Boolean, default: false }
  }
}, { timestamps: true });

// Returns the settings as a plain object with every field filled in (creates the document on first use).
settingSchema.statics.getMain = async function getMain() {
  let doc;
  try {
    doc = await this.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  } catch (e) {
    if (e.code !== 11000) throw e;          // two requests created it at the same time
    doc = await this.findOne({ key: 'main' }).lean();
  }
  return Object.assign({}, DEFAULTS, doc, { announcement: Object.assign({}, DEFAULTS.announcement, (doc && doc.announcement) || {}) });
};

module.exports = mongoose.model('Setting', settingSchema);
