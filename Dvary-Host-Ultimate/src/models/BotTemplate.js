const mongoose = require('mongoose');

// A ready-to-deploy bot the ADMIN prepares once: ZIP + egg + docker image + RAM/CPU/disk + price.
// Customers only press "Deploy" - everything else comes from here.
const botTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  description: { type: String, default: '', trim: true, maxlength: 600 },
  iconUrl: { type: String, default: '', trim: true, maxlength: 700 },      // picture shown on the bot card
  zipFile: { type: String, required: true },                              // file name inside storage/bots
  zipName: { type: String, default: '' },                                 // original file name (for the admin)
  zipSize: { type: Number, default: 0 },
  nestId: { type: Number, required: true },
  eggId: { type: Number, required: true },
  eggName: { type: String, default: '' },
  dockerImage: { type: String, default: '' },                             // empty = egg default
  startup: { type: String, default: '' },                                 // empty = egg default
  environment: { type: mongoose.Schema.Types.Mixed, default: {} },        // egg variables { KEY: 'value' }
  memory: { type: Number, required: true, min: 64 },
  disk: { type: Number, required: true, min: 64 },
  cpu: { type: Number, default: 0, min: 0 },
  databases: { type: Number, default: 0, min: 0 },
  backups: { type: Number, default: 0, min: 0 },
  // price = money, typed by the admin for EACH country (no conversion). TZS in priceTZS, other currencies in prices {KES: 300, UGX: 8000 ...}
  priceTZS: { type: Number, default: 0, min: 0 },
  prices: { type: mongoose.Schema.Types.Mixed, default: {} },
  free: { type: Boolean, default: false },                                // free bot: no payment (one per customer)
  offerCoins: { type: Number, default: 0, min: 0 },                       // OFFER only: customers who were given coins can deploy with this many coins (0 = no coin option)
  coins: { type: Number, default: 0, min: 0 },                            // legacy (not used any more)
  days: { type: Number, default: 0, min: 0 },                             // how long a deploy lasts (0 = no expiry)
  pairing: { type: Boolean, default: true },                              // ask the customer for a phone number + show pair code
  phoneVar: { type: String, default: '' },                                // egg variable that receives the phone number (empty = typed into the console)
  codeRegex: { type: String, default: '' },                               // optional: custom regex to find the pair code in the console
  active: { type: Boolean, default: true, index: true },
  deploys: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('BotTemplate', botTemplateSchema);
