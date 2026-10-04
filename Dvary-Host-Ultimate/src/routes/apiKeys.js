const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const { hashKey } = require('./api');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const MAX_KEYS = 5;
const base = (req) => `${req.protocol}://${req.get('host')}`;

async function page(req, res, extra) {
  const keys = await ApiKey.find({ user: req.user._id, revoked: false }).sort({ createdAt: -1 }).lean();
  res.render('dashboard/api', Object.assign({ active: 'api', pageTitle: 'API', keys, base: base(req), max: MAX_KEYS, newKey: '' }, extra || {}));
}

router.get('/api', wrap((req, res) => page(req, res)));

router.get('/api/docs', wrap(async (req, res) => {
  res.render('dashboard/api-docs', { active: 'api', pageTitle: 'API Docs', base: base(req) });
}));

router.post('/api/keys', wrap(async (req, res) => {
  const count = await ApiKey.countDocuments({ user: req.user._id, revoked: false });
  if (count >= MAX_KEYS) { req.flash('error', `You can have up to ${MAX_KEYS} keys. Delete one first.`); return res.redirect('/dashboard/api'); }
  const name = String(req.body.name || '').trim().slice(0, 40);
  const appUrl = String(req.body.appUrl || '').trim().slice(0, 200);
  const appDescription = String(req.body.appDescription || '').trim().slice(0, 200);
  if (name.length < 2) { req.flash('error', 'Enter the name of your app.'); return res.redirect('/dashboard/api'); }
  if (appUrl && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(appUrl)) { req.flash('error', 'App link must start with https:// (or leave it empty).'); return res.redirect('/dashboard/api'); }
  const key = 'dvk_' + crypto.randomBytes(24).toString('hex');
  await ApiKey.create({ user: req.user._id, name, appUrl, appDescription, prefix: key.slice(0, 10), hash: hashKey(key) });
  // shown ONCE: rendered directly, never stored in plain text
  return page(req, res, { newKey: key });
}));

router.post('/api/keys/:id/revoke', wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await ApiKey.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { revoked: true } });
  req.flash('success', 'API key deleted. It stops working immediately.');
  res.redirect('/dashboard/api');
}));

module.exports = router;
