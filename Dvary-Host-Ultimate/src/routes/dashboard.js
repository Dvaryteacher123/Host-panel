const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const ptero = require('../services/pterodactylService');
const bcrypt = require('bcryptjs');
const Server = require('../models/Server');
const CoinOrder = require('../models/CoinOrder');
const Plan = require('../models/Plan');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const Setting = require('../models/Setting');
const wallet = require('../services/walletService');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const [servers, pendingOrders, recentTx] = await Promise.all([
    Server.find({ user: req.user._id }).sort({ createdAt: -1 }),
    CoinOrder.countDocuments({ user: req.user._id, status: 'pending' }),
    Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(5)
  ]);
  res.render('dashboard/home', {
    active: 'home', servers, pendingOrders, recentTx,
    totalServers: servers.length,
    activeServers: servers.filter((s) => s.status === 'active').length
  });
}));

router.get('/store', wrap(async (req, res) => {
  const plans = await Plan.find({ active: true, kind: { $ne: 'admin' } }).sort({ coins: 1 }).lean();
  const adminPlans = await Plan.find({ active: true, kind: 'admin' }).sort({ coins: 1 }).lean();
  const old = req.session.oldDeploy || {};
  delete req.session.oldDeploy;
  res.render('dashboard/store', { active: 'store', plans, adminPlans, panelBase: (res.locals.site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, ''), old, selected: String(old.plan || req.query.plan || '') });
}));

router.get('/profile', wrap(async (req, res) => {
  const [spent, servers] = await Promise.all([
    Transaction.aggregate([{ $match: { user: req.user._id, type: 'debit' } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Server.countDocuments({ user: req.user._id })
  ]);
  res.render('dashboard/profile', { active: 'profile', totalSpent: spent[0] ? spent[0].sum : 0, serverTotal: servers });
}));

router.post('/profile/password', wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const user = await User.findById(req.user._id);
  if (!(await bcrypt.compare(current, user.password))) { req.flash('error', 'Current password is incorrect.'); return res.redirect('/dashboard/profile'); }
  if (next.length < 8 || next.length > 100) { req.flash('error', 'New password must be at least 8 characters.'); return res.redirect('/dashboard/profile'); }
  if (next !== confirm) { req.flash('error', 'Passwords do not match.'); return res.redirect('/dashboard/profile'); }
  user.password = await bcrypt.hash(next, 12);
  await user.save();
  req.flash('success', 'Password changed.');
  res.redirect('/dashboard/profile');
}));

// ---------- Admin Panel (customer becomes root admin of the Pterodactyl panel) ----------
router.post('/admin-panel/buy', wrap(async (req, res) => {
  const back = '/dashboard/store';
  if (!mongoose.isValidObjectId(req.body.plan)) { req.flash('error', 'Select an Admin Panel plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: req.body.plan, active: true, kind: 'admin' });
  if (!plan) { req.flash('error', 'This plan is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }
  const me = await User.findById(req.user._id);
  if (me.pteroAdmin) { req.flash('error', 'You already own an Admin Panel.'); return res.redirect(back); }
  try {
    await wallet.debitCoins(me._id, plan.coins, 'Admin Panel purchase', { plan: String(plan._id), planName: plan.name });
  } catch (e) {
    if (e instanceof wallet.WalletError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
  try {
    const acct = await ptero.ensureUser(me);
    await ptero.setRootAdmin(acct.id, true);
    const set = { pteroAdmin: true, pteroUserId: acct.id };
    if (acct.created) set.pteroManaged = true;
    await User.updateOne({ _id: me._id }, { $set: set });
    await audit(req, 'buy_admin_panel', me.email, `${plan.name} - ${plan.coins} coins`);
    const url = (res.locals.site.panelUrl || ptero.baseUrl() || '');
    req.flash('success', 'Admin Panel unlocked! Log in at ' + url + ' with ' + me.email + (acct.generatedPassword ? ' and password: ' + acct.generatedPassword + ' (shown only once, save it now)' : ' using your existing panel password (forgot it? use the reset button below).'));
  } catch (e) {
    console.error('admin panel activation failed', e.message);
    await wallet.refundCoins(me._id, plan.coins, 'Admin Panel purchase refund', { planName: plan.name }).catch((er) => console.error('CRITICAL: admin panel refund failed', String(me._id), er));
    req.flash('error', 'Could not activate the Admin Panel. Your coins were refunded. Please try again or contact support.');
  }
  res.redirect(back);
}));

router.post('/admin-panel/password', wrap(async (req, res) => {
  const me = await User.findById(req.user._id);
  if (!me.pteroAdmin || !me.pteroUserId || !me.pteroManaged) { req.flash('error', 'Your panel account was not created here, so use "Forgot password" on the panel.'); return res.redirect('/dashboard/store'); }
  const pw = crypto.randomBytes(12).toString('base64url') + 'aA1';
  try { await ptero.resetUserPassword(me.pteroUserId, pw); } catch (e) { console.error('admin panel password reset failed', e.message); req.flash('error', 'Could not reset the panel password. Please try again.'); return res.redirect('/dashboard/store'); }
  req.flash('success', 'New panel password: ' + pw + ' (shown only once, save it now)');
  res.redirect('/dashboard/store');
}));

module.exports = router;
