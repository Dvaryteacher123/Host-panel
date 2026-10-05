const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Plan = require('../models/Plan');
const wallet = require('../services/walletService');
const pay = require('../services/paymentService');
const expiry = require('../services/expiryService');
const periodSvc = require('../services/periodService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });
const hasPrice = (r) => !r.free && (r.coins > 0 || r.priceTZS > 0 || Object.keys(r.prices || {}).length > 0);

// loads the customer's own server + the paid durations of its plan (renewal choices)
async function load(req, res) {
  if (!validId(req.params.id)) { notFound(res); return null; }
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id });
  if (!server) { notFound(res); return null; }
  const plan = server.plan ? await Plan.findById(server.plan) : null;
  const periods = plan ? periodSvc.list(plan).filter(hasPrice) : [];
  if (!plan || !periods.length || !server.expiresAt || server.isFree) {
    req.flash('error', 'This server cannot be renewed. Buy a paid plan instead.');
    res.redirect('/dashboard/store'); return null;
  }
  return { server, plan, periods };
}

// renewal page: choose a duration, then pay with coins or money
router.get('/checkout/renew/:id', wrap(async (req, res) => {
  const x = await load(req, res); if (!x) return;
  const first = x.periods[0];
  res.render('dashboard/checkout', {
    active: 'servers', mode: 'renew', title: '🔄 Renew · ' + x.server.name, plan: { _id: x.plan._id, name: x.plan.name }, offer: null,
    coins: first.coins, priceTZS: first.priceTZS, prices: first.prices, needName: false, periods: x.periods, coinsEnabled: true,
    coinsAction: '/dashboard/servers/' + x.server._id + '/renew', moneyAction: '/dashboard/pay/renew/' + x.server._id,
    note: x.server.expiresAt > new Date() ? 'Current end date: ' + String(x.server.expiresAt.toISOString().slice(0, 10)) + '. The new time is added after it.' : 'Your server has expired. Renew now to turn it back on.'
  });
}));

// renew with coins
router.post('/servers/:id/renew', wrap(async (req, res) => { return res.redirect('/dashboard/checkout/renew/' + req.params.id); }));

// renew with money (FimiPay)
router.post('/pay/renew/:id', wrap(async (req, res) => {
  const x = await load(req, res); if (!x) return;
  const back = '/dashboard/checkout/renew/' + x.server._id;
  const period = x.periods.find((r) => String(r.index) === String(req.body.period));
  if (!period) { req.flash('error', 'Choose a duration.'); return res.redirect(back); }
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'renew', plan: x.plan, period, server: x.server, serverName: x.server.name, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
}));

module.exports = router;
