const express = require('express');
const mongoose = require('mongoose');
const Zip = require('../models/Zip');
const ZipAccess = require('../models/ZipAccess');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });

function parseZip(b) {
  const z = {
    title: String(b.title || '').trim(), description: String(b.description || '').trim().slice(0, 400),
    url: String(b.url || '').trim(), type: b.type === 'vip' ? 'vip' : 'free', priceTZS: 0, active: b.active === 'on'
  };
  if (!z.title || z.title.length > 80) return { error: 'ZIP title is required (max 80 characters).' };
  let u; try { u = new URL(z.url); } catch (e) { u = null; }
  if (!u || u.protocol !== 'https:' || z.url.length > 600) return { error: 'Paste a valid https:// link (MediaFire).' };
  if (z.type === 'vip') {
    z.priceTZS = Number(b.priceTZS);
    if (!Number.isInteger(z.priceTZS) || z.priceTZS < 1 || z.priceTZS > 1000000000) return { error: 'VIP ZIP needs a price in TZS (whole number, at least 1).' };
  }
  return { zip: z };
}

router.get('/zips', wrap(async (req, res) => {
  const [zips, buyers] = await Promise.all([
    Zip.find().sort({ createdAt: -1 }).limit(300),
    ZipAccess.aggregate([{ $group: { _id: '$zip', n: { $sum: 1 } } }])
  ]);
  const sold = {};
  buyers.forEach((b) => { sold[String(b._id)] = b.n; });
  res.render('admin/zips', { active: 'zips', zips, sold });
}));

router.post('/zips', wrap(async (req, res) => {
  const r = parseZip(Object.assign({}, req.body, { active: 'on' }));
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/zips'); }
  await Zip.create(r.zip);
  await audit(req, 'create_zip', r.zip.title, r.zip.type + (r.zip.type === 'vip' ? ' ' + r.zip.priceTZS + ' TZS' : ''));
  req.flash('success', 'ZIP added to the shop.');
  res.redirect('/admin/zips');
}));

router.post('/zips/:id/toggle', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const z = await Zip.findById(req.params.id);
  if (!z) return notFound(res);
  z.active = !z.active; await z.save();
  await audit(req, z.active ? 'enable_zip' : 'disable_zip', z.title, '');
  req.flash('success', 'ZIP ' + (z.active ? 'is visible' : 'is hidden') + '.');
  res.redirect('/admin/zips');
}));

router.post('/zips/:id/delete', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const z = await Zip.findById(req.params.id);
  if (!z) return notFound(res);
  await ZipAccess.deleteMany({ zip: z._id });
  await Zip.deleteOne({ _id: z._id });
  await audit(req, 'delete_zip', z.title, '');
  req.flash('success', 'ZIP deleted.');
  res.redirect('/admin/zips');
}));

router.post('/zips/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const r = parseZip(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/zips'); }
  await Zip.updateOne({ _id: req.params.id }, r.zip);
  await audit(req, 'edit_zip', r.zip.title, r.zip.type);
  req.flash('success', 'ZIP updated.');
  res.redirect('/admin/zips');
}));

// ---------- Telegram bot status / repair ----------
router.get('/telegram', wrap(async (req, res) => {
  const st = await require('../services/telegramService').status();
  res.render('admin/telegram', { active: 'telegram', st });
}));
router.post('/telegram/setup', wrap(async (req, res) => {
  const r = await require('../services/telegramService').setup();
  req.flash(r.ok ? 'success' : 'error', r.message);
  res.redirect('/admin/telegram');
}));

module.exports = router;
