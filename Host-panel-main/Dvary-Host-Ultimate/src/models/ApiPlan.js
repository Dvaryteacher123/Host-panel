const mongoose = require('mongoose');

// Every permission an API key can have. The admin chooses which ones are on (Admin -> API -> Settings).
const PERMS = {
  'servers.create': 'Create server',
  'servers.read': 'Get server / list servers',
  'servers.status': 'Get server status',
  'servers.start': 'Start server',
  'servers.stop': 'Stop server',
  'servers.restart': 'Restart server',
  'servers.delete': 'Delete server',
  'resources.read': 'Get resources & limits'
};
const DEFAULT_PERMS = Object.keys(PERMS).filter((p) => p !== 'servers.delete');   // delete is OFF by default

// The paid package. ONE document, edited by the admin - price, days, limits and permissions are never hard-coded.
const schema = new mongoose.Schema({
  key: { type: String, default: 'main', unique: true },
  name: { type: String, default: 'DVARY API PRO', trim: true, maxlength: 60 },
  priceTZS: { type: Number, default: 30000, min: 1 },
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },          // optional fixed price per currency { KES: 1500 }
  durationDays: { type: Number, default: 30, min: 1 },
  active: { type: Boolean, default: true },
  features: { type: [String], default: ['API access', 'Pterodactyl server management', 'Server creation through API', 'API usage statistics', 'API key management'] },
  limits: {
    maxServers: { type: Number, default: 20, min: 0 },
    maxRequestsPerDay: { type: Number, default: 10000, min: 0 },       // 0 = unlimited
    maxRequestsPerMinute: { type: Number, default: 60, min: 1 },
    maxRamMB: { type: Number, default: 2048, min: 64 },
    maxDiskMB: { type: Number, default: 5120, min: 64 },
    maxCpu: { type: Number, default: 100, min: 0 }                     // 0 = unlimited
  },
  permissions: { type: [String], default: DEFAULT_PERMS },
  allowedEggs: { type: String, default: '' }                           // optional lines "nestId:eggId" - empty = the default egg of the panel + any egg given
}, { timestamps: true });

schema.statics.getMain = async function () {
  return this.findOneAndUpdate({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true, new: true, setDefaultsOnInsert: true });
};

const Model = mongoose.model('ApiPlan', schema);
Model.PERMS = PERMS;
Model.DEFAULT_PERMS = DEFAULT_PERMS;
module.exports = Model;
