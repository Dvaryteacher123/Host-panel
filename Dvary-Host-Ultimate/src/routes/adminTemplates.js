const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const AdmZip = require('adm-zip');
const BotTemplate = require('../models/BotTemplate');
const Server = require('../models/Server');
const audit = require('../services/auditService');
const { BOT_DIR } = require('../services/botDeploy');
const { wrap } = require('../middleware/auth');
const { economy } = require('../services/paymentService');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const MAX_MB = Number(process.env.BOT_ZIP_MAX_MB || 100);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, BOT_DIR),
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + '.zip')
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /\.zip$/i.test(file.originalname || ''))
}).single('zip');

// multer errors become a normal flash message
const receive = (req, res, next) => upload(req, res, (err) => {
  if (err) { req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? `ZIP is bigger than ${MAX_MB} MB.` : 'Upload failed. Please try again.'); return res.redirect('/admin/templates'); }
  next();
});
const dropFile = (name) => { if (name) fs.promises.unlink(path.join(BOT_DIR, path.basename(name))).catch(() => {}); };

function parseEnv(text) {
  const env = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const m = line.trim().match(/^([A-Z][A-Z0-9_]{0,63})\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].slice(0, 500);
  });
  return env;
}
const int = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; };

function parse(b) {
  const name = String(b.name || '').trim();
  if (!name || name.length > 80) return { error: 'Bot name is required (max 80 chars).' };
  const t = {
    name, description: String(b.description || '').trim().slice(0, 600),
    nestId: int(b.nestId), eggId: int(b.eggId), eggName: String(b.eggName || '').trim().slice(0, 80),
    dockerImage: String(b.dockerImage || '').trim().slice(0, 300), startup: String(b.startup || '').trim().slice(0, 1000),
    environment: parseEnv(b.environment),
    memory: int(b.memory), disk: int(b.disk), cpu: int(b.cpu), databases: int(b.databases), backups: int(b.backups),
    coins: int(b.coins), priceTZS: int(b.priceTZS), prices: {}, days: int(b.days), pairing: b.pairing === 'on',
    phoneVar: String(b.phoneVar || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 64),
    codeRegex: String(b.codeRegex || '').trim().slice(0, 200), active: b.active === 'on'
  };
  const icon = String(b.iconUrl || '').trim();
  if (icon && !/^https:\/\/\S+$/i.test(icon)) return { error: 'Picture URL must start with https://' };
  t.iconUrl = icon.slice(0, 700);
  for (const cur of ['KES','UGX','NGN','GHS','XAF','ZAR']) { const raw=String(b['price_'+cur]||'').trim(); if(raw){ const n=Number(raw); if(!Number.isInteger(n)||n<1||n>1000000000) return {error:'Price '+cur+' must be a whole number >= 1.'}; t.prices[cur]=n; } }
  if (t.priceTZS < 0 || t.priceTZS > 1000000000) return { error: 'TZS price is invalid.' };
  if (!t.nestId || !t.eggId) return { error: 'Choose a Nest and an Egg.' };
  if (t.memory < 64 || t.disk < 64) return { error: 'RAM and Disk must be at least 64 MB.' };
  if (t.cpu < 0 || t.coins < 0 || t.days < 0) return { error: 'CPU, price and days cannot be negative.' };
  if (t.codeRegex) { try { new RegExp(t.codeRegex); } catch (e) { return { error: 'Pair code regex is not valid.' }; } }
  return { t };
}

function zipInfo(file) {
  const zip = new AdmZip(file.path);
  const n = zip.getEntries().filter((e) => !e.isDirectory).length;
  if (!n) throw new Error('empty');
  return { zipFile: path.basename(file.path), zipName: String(file.originalname || '').slice(0, 120), zipSize: file.size };
}

router.get('/templates', wrap(async (req, res) => {
  const [list, live] = await Promise.all([
    BotTemplate.find().sort({ createdAt: -1 }).lean(),
    Server.aggregate([{ $match: { kind: 'bot', status: { $in: ['active', 'pending'] } } }, { $group: { _id: '$template', n: { $sum: 1 } } }])
  ]);
  const liveMap = {}; live.forEach((x) => { liveMap[String(x._id)] = x.n; });
  res.render('admin/templates', { active: 'templates', pageTitle: 'Bot Templates', list, liveMap, maxMb: MAX_MB, coinTZS: economy(res.locals.site).coinPriceTZS });
}));

router.post('/templates', receive, wrap(async (req, res) => {
  const f = req.file;
  const r = parse(req.body);
  if (!f) { req.flash('error', 'Upload the bot as a .zip file.'); return res.redirect('/admin/templates'); }
  if (r.error) { dropFile(f.filename); req.flash('error', r.error); return res.redirect('/admin/templates'); }
  let z; try { z = zipInfo(f); } catch (e) { dropFile(f.filename); req.flash('error', 'This ZIP is empty or broken.'); return res.redirect('/admin/templates'); }
  const t = await BotTemplate.create(Object.assign(r.t, z));
  await audit(req, 'create_bot_template', t.name, `${t.memory}MB / ${t.coins} coins`);
  req.flash('success', 'Bot template created. Customers can deploy it now.');
  res.redirect('/admin/templates');
}));

router.post('/templates/:id', receive, wrap(async (req, res) => {
  const f = req.file;
  if (!validId(req.params.id)) { if (f) dropFile(f.filename); return res.status(404).render('error', { code: 404, message: 'Page not found.' }); }
  const old = await BotTemplate.findById(req.params.id);
  if (!old) { if (f) dropFile(f.filename); return res.status(404).render('error', { code: 404, message: 'Page not found.' }); }
  const r = parse(req.body);
  if (r.error) { if (f) dropFile(f.filename); req.flash('error', r.error); return res.redirect('/admin/templates'); }
  let z = {};
  if (f) { try { z = zipInfo(f); } catch (e) { dropFile(f.filename); req.flash('error', 'This ZIP is empty or broken.'); return res.redirect('/admin/templates'); } }
  const oldFile = f ? old.zipFile : null;
  await BotTemplate.updateOne({ _id: old._id }, { $set: Object.assign(r.t, z) });
  if (oldFile) dropFile(oldFile);
  await audit(req, 'edit_bot_template', r.t.name, f ? 'new ZIP' : '');
  req.flash('success', 'Template saved. New deploys use the new settings.');
  res.redirect('/admin/templates');
}));

router.post('/templates/:id/toggle', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.redirect('/admin/templates');
  const t = await BotTemplate.findById(req.params.id);
  if (t) { t.active = !t.active; await t.save(); }
  res.redirect('/admin/templates');
}));

router.post('/templates/:id/delete', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.redirect('/admin/templates');
  const t = await BotTemplate.findByIdAndDelete(req.params.id);
  if (t) { dropFile(t.zipFile); await audit(req, 'delete_bot_template', t.name, ''); }
  req.flash('success', 'Template deleted. Servers already deployed keep running.');
  res.redirect('/admin/templates');
}));

// admin can download the stored ZIP to check it
router.get('/templates/:id/zip', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.redirect('/admin/templates');
  const t = await BotTemplate.findById(req.params.id).lean();
  if (!t) return res.redirect('/admin/templates');
  res.download(path.join(BOT_DIR, path.basename(t.zipFile)), t.zipName || 'bot.zip');
}));

module.exports = router;
