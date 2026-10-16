// Customer side of the paid DVARY API: subscribe (real payment), generate / revoke key, dashboard, docs.
const express = require('express');
const ApiPlan = require('../models/ApiPlan');
const ApiSubscription = require('../models/ApiSubscription');
const ApiKey = require('../models/ApiKey');
const ApiLog = require('../models/ApiLog');
const PaymentOrder = require('../models/PaymentOrder');
const pay = require('../services/paymentService');
const subSvc = require('../services/apiSubscription');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const base = (req) => `${req.protocol}://${req.get('host')}`;

function go(res, order) {
  if (order.gatewayUrl) return res.redirect(order.gatewayUrl);       // card / non-TZ mobile: FimiPay checkout page
  return res.redirect('/dashboard/pay/' + order._id);                // Tanzania mobile: wait for the phone prompt
}

async function page(req, res, extra) {
  const [plan, sub] = await Promise.all([ApiPlan.getMain(), ApiSubscription.findOne({ user: req.user._id })]);
  const data = { active: 'api', pageTitle: 'API', plan, priceText: subSvc.priceText(plan), sub, st: subSvc.state(sub), left: subSvc.daysLeft(sub), base: base(req), newKey: '', keyRec: null, used: 0, limits: subSvc.limitsFor(plan, sub), perms: [], today: 0, logs: [], orders: [], PERMS: ApiPlan.PERMS };
  if (sub) {
    const [keyRec, used, today, logs] = await Promise.all([
      ApiKey.findOne({ subscription: sub._id, status: 'active' }).lean(),
      subSvc.serversUsed(req.user._id), subSvc.requestsToday(sub._id),
      ApiLog.find({ subscription: sub._id }).sort({ createdAt: -1 }).limit(10).lean()
    ]);
    Object.assign(data, { keyRec, used, today, logs, perms: subSvc.permsFor(plan, sub) });
  }
  data.orders = await PaymentOrder.find({ user: req.user._id, kind: 'api' }).sort({ createdAt: -1 }).limit(5).lean();
  res.render('dashboard/api', Object.assign(data, extra || {}));
}

router.get('/api', wrap((req, res) => page(req, res)));

router.get('/api/docs', wrap(async (req, res) => {
  const plan = await ApiPlan.getMain();
  res.render('dashboard/api-docs', { active: 'api', pageTitle: 'API Docs', base: base(req), plan, priceText: subSvc.priceText(plan), PERMS: ApiPlan.PERMS });
}));

// Subscribe / renew: starts a REAL payment. Nothing is unlocked here - the subscription is created only when the payment is confirmed.
router.post('/api/subscribe', wrap(async (req, res) => {
  const back = '/dashboard/api';
  const plan = await ApiPlan.getMain();
  if (!plan.active) { req.flash('error', 'The API package is not available right now.'); return res.redirect(back); }
  const period = { index: -1, days: plan.durationDays, label: plan.durationDays + ' days', coins: 0, priceTZS: plan.priceTZS, prices: plan.prices || {} };
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'api', period, country: req.body.country, method: req.body.method, phone: req.body.phone });
    await PaymentOrder.updateOne({ _id: order._id }, { $set: { planName: plan.name } });
    return go(res, order);
  } catch (e) {
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
}));

// Generate / regenerate the key - only with an ACTIVE paid subscription
router.post('/api/key', wrap(async (req, res) => {
  const sub = await ApiSubscription.findOne({ user: req.user._id });
  const st = subSvc.state(sub);
  if (st !== 'active') { req.flash('error', st === 'none' ? 'Subscribe and pay first to get an API key.' : (st === 'expired' ? 'Your subscription expired. Renew it to generate a key.' : 'Your API access is suspended. Contact support.')); return res.redirect('/dashboard/api'); }
  const name = String(req.body.name || '').trim().slice(0, 40) || 'My app';
  const appUrl = String(req.body.appUrl || '').trim().slice(0, 200);
  if (appUrl && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(appUrl)) { req.flash('error', 'App link must start with https:// (or leave it empty).'); return res.redirect('/dashboard/api'); }
  const { key } = await subSvc.generateKey(sub, { name, appUrl, appDescription: req.body.appDescription });
  return page(req, res, { newKey: key });     // shown ONCE, never stored in plain text
}));

router.post('/api/key/revoke', wrap(async (req, res) => {
  const sub = await ApiSubscription.findOne({ user: req.user._id });
  if (sub) await subSvc.revokeKeys(sub._id);
  req.flash('success', 'API key revoked. It stops working immediately.');
  res.redirect('/dashboard/api');
}));

module.exports = router;
