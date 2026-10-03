const express = require('express');
const mongoose = require('mongoose');
const Plan = require('../models/Plan');
const PaymentOrder = require('../models/PaymentOrder');
const pay = require('../services/paymentService');
const fimipay = require('../services/fimipayService');
const ptero = require('../services/pterodactylService');
const periodSvc = require('../services/periodService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

function fail(req, res, back, e) {
  if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
  throw e;
}
function go(res, order) {
  // card / non-Tanzania mobile: the customer finishes on the FimiPay checkout page
  if (order.gatewayUrl) return res.redirect(order.gatewayUrl);
  return res.redirect('/dashboard/pay/' + order._id);          // Tanzania mobile: wait for the USSD prompt
}

// Buy a server with real money (automatic delivery after payment)
router.post('/pay/server', wrap(async (req, res) => {
  const back = '/dashboard/store';
  const name = String(req.body.name || '').trim();
  req.session.oldDeploy = { name, plan: String(req.body.plan || '') };
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  if (!validId(req.body.plan)) { req.flash('error', 'Select a plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: req.body.plan, active: true, kind: { $ne: 'admin' } });
  if (!plan) { req.flash('error', 'This plan is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }
  let period = null;
  if (periodSvc.list(plan).length) {
    period = periodSvc.pick(plan, req.body.period);
    if (!period) { req.flash('error', 'Choose a duration.'); return res.redirect(back); }
    if (period.free) { req.flash('error', 'The free trial needs no payment. Use the free button.'); return res.redirect(back); }
  }
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'server', plan, period, serverName: name, country: req.body.country, method: req.body.method, phone: req.body.phone });
    delete req.session.oldDeploy;
    return go(res, order);
  } catch (e) { return fail(req, res, back, e); }
}));

// Buy coins with real money (coins are added automatically after payment)
router.post('/pay/coins', wrap(async (req, res) => {
  const back = '/dashboard/coins';
  const coins = Number(req.body.coins);
  if (!Number.isInteger(coins) || coins < 1 || coins > 1000000) { req.flash('error', 'Enter a valid amount of coins.'); return res.redirect(back); }
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'coins', coins, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return go(res, order);
  } catch (e) { return fail(req, res, back, e); }
}));

// Payment status page (the customer lands here after paying)
router.get('/pay/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  let order = await PaymentOrder.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  try { order = await pay.sync(order); } catch (e) { console.error('[pay] page sync failed', e.message); }
  // the Admin Panel login password is shown ONE time, then wiped
  let panelPassword = '';
  if (order.kind === 'adminplan' && order.fulfilled && order.panelPassword) {
    panelPassword = order.panelPassword;
    await PaymentOrder.updateOne({ _id: order._id }, { $set: { panelPassword: '' } });
  }
  const panelBase = String(res.locals.site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, '');
  res.render('dashboard/pay', { active: 'coins', order, panelPassword, panelBase });
}));

// polled by the status page every few seconds
router.get('/pay/:id/status', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  let order = await PaymentOrder.findOne({ _id: req.params.id, user: req.user._id });
  if (!order) return res.status(404).json({ ok: false });
  if (order.status === 'pending' && (!order.lastCheckAt || Date.now() - order.lastCheckAt.getTime() > 3000)) {
    try { order = await pay.sync(order); } catch (e) { console.error('[pay] status sync failed', e.message); }
  }
  if (order.status === 'paid' && !order.fulfilled) { await pay.fulfil(order._id); order = await PaymentOrder.findById(order._id); }
  res.json({ ok: true, status: order.status, fulfilled: order.fulfilled, kind: order.kind, serverId: order.server ? String(order.server) : null, botId: order.bot ? String(order.bot) : null });
}));

// ---------- FimiPay webhook (public, signed) ----------
// Mounted in server.js BEFORE the body parsers because the signature is computed over the RAW body.
router.webhook = async (req, res) => {
  try {
    if (!process.env.FIMIPAY_WEBHOOK_SECRET) { console.error('[webhook] FIMIPAY_WEBHOOK_SECRET is not set'); return res.status(503).send('Not configured'); }
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const sig = req.get('x-fimipay-signature') || '';
    if (!fimipay.verifySignature(raw, sig)) { console.warn('[webhook] invalid signature'); return res.status(401).send('Invalid signature'); }

    let body = {};
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).send('Bad JSON'); }
    const d = body.data && typeof body.data === 'object' ? body.data : {};
    const orderId = String(body.order_id || d.order_id || (d.object && d.object.order_id) || '');
    const order = orderId ? await PaymentOrder.findOne({ orderId }) : null;
    // unknown order: answer 200 anyway; the background reconcile will pick the payment up once it is saved
    if (order) {
      try { await pay.sync(order); } catch (e) { console.error('[webhook] sync failed', e.message); }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('[webhook] error', e.message);
    return res.status(500).send('Error');
  }
};

module.exports = router;
