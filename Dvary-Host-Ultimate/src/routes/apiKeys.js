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

router.post('/api/keys/pay', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const appUrl = String(req.body.appUrl || '').trim().slice(0, 200);
  const appDescription = String(req.body.appDescription || '').trim().slice(0, 200);
  if (name.length < 2) { req.flash('error', 'Enter the name of your app.'); return res.redirect('/dashboard/api'); }
  if (appUrl && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(appUrl)) { req.flash('error', 'App link must start with https:// (or leave it empty).'); return res.redirect('/dashboard/api'); }
  const pending = await require('../models/PaymentOrder').countDocuments({ user: req.user._id, kind: 'apikey', status: { $in: ['creating','pending'] }, createdAt: { $gt: new Date(Date.now()-3600*1000) } });
  if (pending >= 3) { req.flash('error', 'You already have unfinished API key payments. Finish one first.'); return res.redirect('/dashboard/api'); }
  try {
    const order = await require('../services/paymentService').createPayment({ user: req.user, kind: 'apikey', apiKeyName: name, apiKeyUrl: appUrl, apiKeyDescription: appDescription, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    if (e instanceof require('../services/paymentService').PayError) { req.flash('error', e.message); return res.redirect('/dashboard/api'); }
    throw e;
  }
}));

router.post('/api/keys/:id/revoke', wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await ApiKey.updateOne({ _id: req.params.id, user: req.user._id }, { $set: { revoked: true } });
  req.flash('success', 'API key deleted. It stops working immediately.');
  res.redirect('/dashboard/api');
}));

module.exports = router;
