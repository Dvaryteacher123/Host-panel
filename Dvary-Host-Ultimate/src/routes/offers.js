const express = require('express');
const mongoose = require('mongoose');
const Offer = require('../models/Offer');
const Plan = require('../models/Plan');
const Server = require('../models/Server');
const User = require('../models/User');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const queue = require('../services/deployQueue');
const pay = require('../services/paymentService');
const periodSvc = require('../services/periodService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });
const activeFilter = () => ({ status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });

// ---------- plan page: everything about one plan + where the customer pays ----------
router.get('/plan/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const plan = await Plan.findOne({ _id: req.params.id, active: true, kind: { $ne: 'admin' } }).lean();
  if (!plan) return notFound(res);
  const periods = periodSvc.list(plan);
  let selIndex = -1;
  if (periods.length) {
    const asked = periods.find((r) => String(r.index) === String(req.query.period));
    const firstPaid = periods.find((r) => !r.free);
    selIndex = (asked || firstPaid || periods[0]).index;
  }
  const old = req.session.oldDeploy || {}; delete req.session.oldDeploy;
  res.render('dashboard/plan', {
    active: 'store', plan, periods, selIndex,
    defCountry: String(req.query.country || '').toUpperCase().slice(0, 2),
    oldName: old.name || '', freeUsed: !!req.user.freeUsed
  });
}));

// ---------- checkout pages (coins OR money) ----------
router.get('/checkout/offer/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const offer = await Offer.findOne(Object.assign({ _id: req.params.id, user: req.user._id }, activeFilter())).populate('plan');
  if (!offer || !offer.plan) { req.flash('error', 'This offer is no longer available.'); return res.redirect('/dashboard/store'); }
  const p = offer.plan;
  res.render('dashboard/checkout', {
    active: 'store', mode: 'offer', title: '🎁 Your offer', plan: p, offer,
    coins: offer.coins, priceTZS: offer.priceTZS, prices: offer.prices || {}, needName: true,
    coinsAction: '/dashboard/offers/' + offer._id + '/claim', moneyAction: '/dashboard/pay/offer/' + offer._id, note: offer.note
  });
}));

router.get('/checkout/admin/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const plan = await Plan.findOne({ _id: req.params.id, active: true, kind: 'admin' });
  if (!plan) return notFound(res);
  res.render('dashboard/checkout', {
    active: 'store', mode: 'admin', title: '👑 ' + plan.name, plan, offer: null,
    coins: plan.coins, priceTZS: plan.priceTZS || 0, prices: plan.prices || {}, needName: false,
    coinsAction: '/dashboard/admin-panel/buy', moneyAction: '/dashboard/pay/admin-panel', note: plan.description
  });
}));

// ---------- claim an offer with coins ----------
router.post('/offers/:id/claim', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const back = '/dashboard/checkout/offer/' + req.params.id;
  const name = String(req.body.name || '').trim();
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }

  // claim atomically: one offer = one server, even with double clicks
  const offer = await Offer.findOneAndUpdate(Object.assign({ _id: req.params.id, user: req.user._id }, activeFilter()), { $set: { status: 'used', usedAt: new Date(), usedWith: 'coins' } });
  if (!offer) { req.flash('error', 'This offer is no longer available.'); return res.redirect('/dashboard/store'); }
  const revert = () => Offer.updateOne({ _id: offer._id }, { $set: { status: 'active', usedAt: null, usedWith: '' } });

  const plan = await Plan.findOne({ _id: offer.plan, active: true, kind: { $ne: 'admin' } });
  if (!plan) { await revert(); req.flash('error', 'This plan is not available.'); return res.redirect('/dashboard/store'); }

  let debit = null;
  if (offer.coins > 0) {
    try {
      debit = await wallet.debitCoins(req.user._id, offer.coins, 'Server purchase (offer)', { offer: String(offer._id), plan: String(plan._id), planName: plan.name, serverName: name });
    } catch (e) {
      await revert();
      if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }
      throw e;
    }
  }
  const server = await Server.create({
    user: req.user._id, plan: plan._id, planName: plan.name, name, status: 'pending', paidCoins: offer.coins,
    expiresAt: offer.serverDays > 0 ? periodSvc.addDays(new Date(), offer.serverDays) : null, periodDays: offer.serverDays || 0,
    resources: { memory: plan.memory, disk: plan.disk, cpu: plan.cpu, databases: plan.databases, backups: plan.backups },
    deploymentStatus: 'In queue…'
  });
  await Offer.updateOne({ _id: offer._id }, { $set: { server: server._id } });
  const { runProvision } = require('./servers');
  queue.enqueue(() => runProvision({ serverId: server._id, userId: req.user._id, planId: plan._id, name, debitReference: debit ? debit.transaction.reference : 'OFFER-FREE', refundAmount: offer.coins }));
  req.flash('success', 'Offer claimed! Creating your server… this page updates by itself.');
  res.redirect('/dashboard/server/' + server._id);
}));

// ---------- pay for an offer / the Admin Panel with money ----------
function payFail(req, res, back, e) {
  if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
  throw e;
}
const go = (res, order) => res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));

router.post('/pay/offer/:id', wrap(async (req, res) => { req.flash('error', 'Offers are coin-only. Use the Coins offer balance issued by the admin.'); return res.redirect('/dashboard/store'); }));

router.post('/pay/admin-panel', wrap(async (req, res) => {
  const back = '/dashboard/store';
  if (!validId(req.body.plan)) { req.flash('error', 'Select an Admin Panel plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: req.body.plan, active: true, kind: 'admin' });
  if (!plan) { req.flash('error', 'This plan is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }
  const me = await User.findById(req.user._id);
  if (me.pteroAdmin) { req.flash('error', 'You already own an Admin Panel.'); return res.redirect(back); }
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'adminplan', plan, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return go(res, order);
  } catch (e) { return payFail(req, res, '/dashboard/checkout/admin/' + plan._id, e); }
}));

module.exports = router;
