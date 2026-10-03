const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Server = require('../models/Server');
const Transaction = require('../models/Transaction');
const CoinOrder = require('../models/CoinOrder');
const PaymentOrder = require('../models/PaymentOrder');
const Offer = require('../models/Offer');
const BotZip = require('../models/BotZip');
const BotAccess = require('../models/BotAccess');
const payments = require('../services/paymentService');
const Setting = require('../models/Setting');
const Notification = require('../models/Notification');
const { deleteUserFully } = require('../services/userService');
const AuditLog = require('../models/AuditLog');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();

const canTouch = (req, target) => !isSelf(req, target._id);
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isSelf = (req, id) => String(req.user._id) === String(id);
const safeBack = (b, fallback) => (String(b || '').startsWith('/admin/') && !String(b).includes('//') ? String(b) : fallback);
// ---------- dashboard ----------
async function series(Model, match, valueExpr, days, since) {
  const rows = await Model.aggregate([
    { $match: { createdAt: { $gte: since }, ...match } },
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, v: { $sum: valueExpr } } }
  ]);
  const map = {};
  rows.forEach((r) => { map[r._id] = r.v; });
  return days.map((d) => ({ label: d.slice(5), value: map[d] || 0 }));
}

router.get('/', wrap(async (req, res) => {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0); since.setUTCDate(since.getUTCDate() - 6);
  const days = [...Array(7)].map((_, i) => { const d = new Date(since); d.setUTCDate(since.getUTCDate() + i); return d.toISOString().slice(0, 10); });

  const [totalUsers, totalServers, activeServers, pendingOrders, totalTransactions, issued, users, servers, orders, transactions, coinSeries, userSeries] = await Promise.all([
    User.countDocuments(), Server.countDocuments(), Server.countDocuments({ status: 'active' }),
    CoinOrder.countDocuments({ status: 'pending' }), Transaction.countDocuments(),
    Transaction.aggregate([{ $match: { type: 'credit' } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    User.find().sort({ createdAt: -1 }).limit(5),
    Server.find().sort({ createdAt: -1 }).limit(5).populate('user', 'name email'),
    CoinOrder.find().sort({ createdAt: -1 }).limit(5).populate('user', 'name email'),
    Transaction.find().sort({ createdAt: -1 }).limit(5).populate('user', 'name email'),
    series(Transaction, { type: 'credit' }, '$amount', days, since),
    series(User, {}, 1, days, since)
  ]);
  res.render('admin/home', {
    active: 'home', totalUsers, totalServers, activeServers, pendingOrders, totalTransactions,
    totalIssued: issued[0] ? issued[0].sum : 0, users, servers, orders, transactions, coinSeries, userSeries
  });
}));

// ---------- users ----------
router.get('/users', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const filter = q ? { $or: [{ name: new RegExp(esc(q), 'i') }, { email: new RegExp(esc(q), 'i') }] } : {};
  const users = await User.find(filter).select('-password').sort({ createdAt: -1 }).limit(300);
  const counts = await Server.aggregate([{ $match: { user: { $in: users.map((u) => u._id) } } }, { $group: { _id: '$user', n: { $sum: 1 } } }]);
  const serverCount = {};
  counts.forEach((c) => { serverCount[String(c._id)] = c.n; });
  res.render('admin/users', { active: 'users', users, serverCount, q });
}));

router.post('/users/give', wrap(async (req, res) => {
  const dest = safeBack(req.body.back, '/admin/users');
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!validId(req.body.userId)) { req.flash('error', 'Select a user.'); return res.redirect(dest); }
  if (!Number.isInteger(amount) || amount <= 0) { req.flash('error', 'Amount must be a positive whole number.'); return res.redirect(dest); }
  try {
    const { user } = await wallet.creditCoins(req.body.userId, amount, 'Admin coin grant', { reason, adminId: String(req.user._id) });
    await audit(req, 'give_coins', user.email, `+${amount} coins. ${reason}`);
    req.flash('success', `Gave ${amount} coins to ${user.name}. New balance: ${user.coins}.`);
  } catch (e) {
    if (e instanceof wallet.WalletError) req.flash('error', e.message); else throw e;
  }
  res.redirect(dest);
}));

router.post('/users/take', wrap(async (req, res) => {
  const dest = safeBack(req.body.back, '/admin/users');
  const amount = Number(req.body.amount);
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!validId(req.body.userId)) { req.flash('error', 'Select a user.'); return res.redirect(dest); }
  if (!Number.isInteger(amount) || amount <= 0) { req.flash('error', 'Amount must be a positive whole number.'); return res.redirect(dest); }
  try {
    const { user } = await wallet.debitCoins(req.body.userId, amount, 'Admin coin deduction', { reason, adminId: String(req.user._id) });
    await audit(req, 'take_coins', user.email, `-${amount} coins. ${reason}`);
    req.flash('success', `Removed ${amount} coins from ${user.name}. New balance: ${user.coins}.`);
  } catch (e) {
    if (e instanceof wallet.WalletError) req.flash('error', e.message); else throw e;
  }
  res.redirect(dest);
}));

router.get('/users/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const target = await User.findById(req.params.id).select('-password');
  if (!target) return notFound(res);
  const [servers, transactions] = await Promise.all([
    Server.find({ user: target._id }).sort({ createdAt: -1 }),
    Transaction.find({ user: target._id }).sort({ createdAt: -1 }).limit(100)
  ]);
  res.render('admin/user', { active: 'users', target, servers, transactions });
}));

router.post('/users/:id/role', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const dest = '/admin/users/' + req.params.id;
  const role = req.body.role;
  if (!['user', 'admin'].includes(role)) { req.flash('error', 'Invalid role.'); return res.redirect(dest); }
  if (isSelf(req, req.params.id)) { req.flash('error', 'You cannot change your own role.'); return res.redirect(dest); }
  const u = await User.findByIdAndUpdate(req.params.id, { role });
  if (!u) return notFound(res);
  await audit(req, 'set_role', u.email, `role -> ${role}`);
  req.flash('success', `Role changed to ${role}.`);
  res.redirect(dest);
}));

router.post('/users/:id/ban', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const dest = '/admin/users/' + req.params.id;
  if (isSelf(req, req.params.id)) { req.flash('error', 'You cannot ban yourself.'); return res.redirect(dest); }
  const u = await User.findById(req.params.id);
  if (!u) return notFound(res);
  if (!canTouch(req, u)) { req.flash('error', 'You cannot manage this account.'); return res.redirect(dest); }
  u.banned = !u.banned;
  await u.save();
  await audit(req, u.banned ? 'ban_user' : 'unban_user', u.email, '');
  req.flash('success', u.banned ? 'User suspended.' : 'User restored.');
  res.redirect(dest);
}));

router.post('/users/:id/delete', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const target = await User.findById(req.params.id);
  if (!target) return notFound(res);
  if (!canTouch(req, target)) { req.flash('error', 'You cannot delete this account.'); return res.redirect('/admin/users/' + req.params.id); }
  const r = await deleteUserFully(target);
  if (!r.ok) { req.flash('error', r.error); return res.redirect('/admin/users/' + req.params.id); }
  await audit(req, 'delete_user', target.email, `${r.servers} server(s) removed`);
  req.flash('success', `User ${target.name} deleted (${r.servers} server${r.servers === 1 ? '' : 's'} removed).`);
  res.redirect('/admin/users');
}));

router.post('/users/:id/revoke-panel-admin', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const dest = '/admin/users/' + req.params.id;
  const u = await User.findById(req.params.id);
  if (!u) return notFound(res);
  if (!u.pteroAdmin || !u.pteroUserId) { req.flash('error', 'This user is not a panel admin.'); return res.redirect(dest); }
  try { await ptero.setRootAdmin(u.pteroUserId, false); } catch (e) { console.error('revoke panel admin failed', e.message); req.flash('error', 'Panel request failed. Admin access was NOT removed. See server logs.'); return res.redirect(dest); }
  await User.updateOne({ _id: u._id }, { $set: { pteroAdmin: false } });
  await audit(req, 'revoke_panel_admin', u.email, '');
  req.flash('success', 'Panel admin access removed.');
  res.redirect(dest);
}));

router.post('/users/:id/password', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const dest = '/admin/users/' + req.params.id;
  const pw = String(req.body.password || '');
  if (pw.length < 8 || pw.length > 100) { req.flash('error', 'Password must be at least 8 characters.'); return res.redirect(dest); }
  const u = await User.findById(req.params.id);
  if (!u) return notFound(res);
  u.password = await bcrypt.hash(pw, 12);
  await u.save();
  await audit(req, 'reset_password', u.email, '');
  req.flash('success', 'Password reset.');
  res.redirect(dest);
}));

// ---------- plans ----------
// durations of a server plan: up to 7 rows (days + coins + money + optional per-country prices, or FREE)
function parsePeriods(b) {
  const periods = []; const seen = new Set();
  for (let i = 0; i < 7; i++) {
    const daysRaw = String(b['pd_days_' + i] || '').trim();
    if (!daysRaw) continue;
    const days = Number(daysRaw);
    if (!Number.isInteger(days) || days < 1 || days > 3650) return { error: 'Days must be a whole number between 1 and 3650.' };
    if (seen.has(days)) return { error: 'Two rows have the same number of days (' + days + ').' };
    seen.add(days);
    const free = b['pd_free_' + i] === 'on';
    let coins = 0; let priceTZS = 0; const prices = {};
    if (!free) {
      coins = Number(b['pd_coins_' + i] || 0); priceTZS = Number(b['pd_tzs_' + i] || 0);
      if (!Number.isInteger(coins) || coins < 0 || coins > 100000000) return { error: 'Coins in the ' + days + '-day row must be a whole number >= 0.' };
      if (!Number.isInteger(priceTZS) || priceTZS < 0 || priceTZS > 1000000000) return { error: 'Money (TZS) in the ' + days + '-day row must be a whole number >= 0.' };
      for (const cur of MONEY_CUR) {
        const raw = String(b['pd_price_' + cur + '_' + i] || '').trim();
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1 || n > 1000000000) return { error: 'Price ' + cur + ' in the ' + days + '-day row must be a whole number >= 1.' };
        prices[cur] = n;
      }
      if (coins < 1 && !(priceTZS > 0) && !Object.keys(prices).length) return { error: 'The ' + days + '-day row needs a price (coins or money), or tick FREE.' };
    }
    periods.push({ days, free, coins, priceTZS, prices });
  }
  periods.sort((a, b2) => a.days - b2.days);
  if (periods.filter((x) => x.free).length > 1) return { error: 'Only one FREE row per plan.' };
  return { periods };
}

function parsePlan(b) {
  const int = (v) => Number(v);
  const p = {
    name: String(b.name || '').trim(), description: String(b.description || '').trim().slice(0, 300),
    coins: int(b.coins), priceTZS: int(b.priceTZS || 0), memory: int(b.memory), disk: int(b.disk), cpu: int(b.cpu),
    databases: int(b.databases || 0), backups: int(b.backups || 0), active: b.active === 'on',
    nestId: Number(b.nestId) > 0 ? Number(b.nestId) : null, eggId: Number(b.eggId) > 0 ? Number(b.eggId) : null,
    dockerImage: String(b.dockerImage || '').trim().slice(0, 200), startup: String(b.startup || '').trim().slice(0, 500),
    eggName: String(b.eggName || '').trim().slice(0, 80), imageLabel: String(b.imageLabel || '').trim().slice(0, 80)
  };
  p.prices = {};
  for (const cur of ['KES','UGX','NGN','GHS','XAF','ZAR']) {
    const raw = String(b['price_' + cur] || '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 1000000000) return { error: 'Price ' + cur + ' must be a whole number >= 1 (or empty = automatic).' };
    p.prices[cur] = n;
  }
  const okInt = (n, min) => Number.isInteger(n) && n >= min;
  if (!p.name || p.name.length > 60) return { error: 'Plan name is required (max 60 chars).' };
  const per = parsePeriods(b);
  if (per.error) return per;
  p.periods = per.periods;
  if (p.periods.length) {
    const paid = p.periods.filter((x) => !x.free && x.coins > 0).map((x) => x.coins);
    p.coins = paid.length ? Math.min.apply(null, paid) : 0;     // shown as "from" price; the real prices are in the durations
  } else if (!okInt(p.coins, 1)) return { error: 'Coin price must be a whole number >= 1 (or add durations below).' };
  if (!okInt(p.priceTZS, 0) || p.priceTZS > 1000000000) return { error: 'Money price (TZS) must be a whole number >= 0 (0 = automatic).' };
  if (!okInt(p.memory, 64) || !okInt(p.disk, 64)) return { error: 'RAM and Disk must be whole numbers in MB (>= 64).' };
  if (!okInt(p.cpu, 0)) return { error: 'CPU must be a whole number >= 0.' };
  if (!okInt(p.databases, 0) || !okInt(p.backups, 0)) return { error: 'Databases and backups must be whole numbers >= 0.' };
  return { plan: p };
}

// JSON lists used by the Nest / Egg / Node dropdowns on the plan form
router.get('/plans/ptero/nests', wrap(async (_req, res) => {
  if (!ptero.isConfigured()) return res.status(400).json({ error: 'Pterodactyl is not configured.' });
  try { res.json({ nests: await ptero.listNests() }); } catch (e) { console.error('nest list failed', e.message); res.status(502).json({ error: 'Could not load nests from the panel.' }); }
}));
router.get('/plans/ptero/nests/:nest/eggs', wrap(async (req, res) => {
  if (!ptero.isConfigured()) return res.status(400).json({ error: 'Pterodactyl is not configured.' });
  try { res.json({ eggs: await ptero.listEggs(req.params.nest) }); } catch (e) { console.error('egg list failed', e.message); res.status(502).json({ error: 'Could not load eggs from the panel.' }); }
}));

// ---------- Admin Panel plans (what a customer buys to become panel admin) ----------
const MONEY_CUR = ['KES','UGX','NGN','GHS','XAF','ZAR'];
// optional money prices (TZS + fixed price per currency) shared by Admin Panel plans and offers
function parseMoney(b) {
  const priceTZS = Number(b.priceTZS || 0);
  if (!Number.isInteger(priceTZS) || priceTZS < 0 || priceTZS > 1000000000) return { error: 'Money price (TZS) must be a whole number >= 0 (0 = automatic).' };
  const prices = {};
  for (const cur of MONEY_CUR) {
    const raw = String(b['price_' + cur] || '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 1000000000) return { error: 'Price ' + cur + ' must be a whole number >= 1 (or empty = automatic).' };
    prices[cur] = n;
  }
  return { priceTZS, prices };
}
function parseAdminPlan(b) {
  const p = { kind: 'admin', name: String(b.name || '').trim(), description: String(b.description || '').trim().slice(0, 300), coins: Number(b.coins), active: b.active === 'on' };
  if (!p.name || p.name.length > 60) return { error: 'Plan name is required (max 60 chars).' };
  if (!Number.isInteger(p.coins) || p.coins < 1) return { error: 'Coin price must be a whole number >= 1.' };
  const m = parseMoney(b);
  if (m.error) return m;
  p.priceTZS = m.priceTZS; p.prices = m.prices;
  return { plan: p };
}
router.post('/plans/admin-create', wrap(async (req, res) => {
  const r = parseAdminPlan(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/plans'); }
  await Plan.create(r.plan);
  await audit(req, 'create_admin_plan', r.plan.name, `${r.plan.coins} coins`);
  req.flash('success', 'Admin Panel plan created.');
  res.redirect('/admin/plans');
}));
router.post('/plans/admin-edit/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const r = parseAdminPlan(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/plans'); }
  await Plan.updateOne({ _id: req.params.id, kind: 'admin' }, r.plan);
  await audit(req, 'edit_admin_plan', r.plan.name, `${r.plan.coins} coins`);
  req.flash('success', 'Admin Panel plan updated.');
  res.redirect('/admin/plans');
}));

router.get('/plans', wrap(async (req, res) => {
  const all = await Plan.find().sort({ coins: 1 });
  res.render('admin/plans', { active: 'plans', plans: all.filter((p) => p.kind !== 'admin'), adminPlans: all.filter((p) => p.kind === 'admin') });
}));
router.post('/plans', wrap(async (req, res) => {
  const r = parsePlan(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/plans'); }
  await Plan.create(r.plan);
  await audit(req, 'create_plan', r.plan.name, `${r.plan.coins} coins`);
  req.flash('success', 'Plan created.');
  res.redirect('/admin/plans');
}));
router.post('/plans/:id/toggle', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const plan = await Plan.findById(req.params.id);
  if (!plan) return notFound(res);
  plan.active = !plan.active;
  await plan.save();
  await audit(req, plan.active ? 'enable_plan' : 'disable_plan', plan.name, '');
  req.flash('success', `Plan ${plan.active ? 'enabled' : 'disabled'}.`);
  res.redirect('/admin/plans');
}));
router.post('/plans/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const r = parsePlan(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/plans'); }
  await Plan.updateOne({ _id: req.params.id }, r.plan);
  await audit(req, 'edit_plan', r.plan.name, `${r.plan.coins} coins`);
  req.flash('success', 'Plan updated.');
  res.redirect('/admin/plans');
}));

// ---------- servers ----------
router.get('/servers', wrap(async (req, res) => {
  const servers = await Server.find().sort({ createdAt: -1 }).limit(500).populate('user', 'name email');
  res.render('admin/servers', { active: 'servers', servers });
}));

async function loadPteroServer(req, res) {
  if (!validId(req.params.id)) { notFound(res); return null; }
  const s = await Server.findById(req.params.id);
  if (!s) { notFound(res); return null; }
  return s;
}

router.post('/servers/:id/suspend', wrap(async (req, res) => {
  const s = await loadPteroServer(req, res); if (!s) return;
  try {
    if (s.pteroId) await ptero.suspendServer(s.pteroId);
    s.status = 'suspended'; await s.save();
    await audit(req, 'suspend_server', s.name, `ptero ${s.pteroId}`);
    req.flash('success', 'Server suspended.');
  } catch (e) { console.error(e); req.flash('error', 'Panel request failed. See server logs.'); }
  res.redirect('/admin/servers');
}));
router.post('/servers/:id/unsuspend', wrap(async (req, res) => {
  const s = await loadPteroServer(req, res); if (!s) return;
  try {
    if (s.pteroId) await ptero.unsuspendServer(s.pteroId);
    s.status = 'active'; await s.save();
    await audit(req, 'unsuspend_server', s.name, `ptero ${s.pteroId}`);
    req.flash('success', 'Server unsuspended.');
  } catch (e) { console.error(e); req.flash('error', 'Panel request failed. See server logs.'); }
  res.redirect('/admin/servers');
}));
router.post('/servers/:id/delete', wrap(async (req, res) => {
  const s = await loadPteroServer(req, res); if (!s) return;
  try {
    if (s.pteroId) {
      try { await ptero.deleteServer(s.pteroId); } catch (e) { if (e.status !== 404) throw e; }
    }
  } catch (e) { console.error(e); req.flash('error', 'Panel request failed, server not deleted. See server logs.'); return res.redirect('/admin/servers'); }
  let refunded = '';
  if (req.body.refund === 'on' && s.plan) {
    const plan = await Plan.findById(s.plan);
    if (plan) {
      await wallet.refundCoins(s.user, plan.coins, 'Server removed by admin - refund', { serverName: s.name, adminId: String(req.user._id) });
      refunded = ` refunded ${plan.coins}`;
    }
  }
  await Server.deleteOne({ _id: s._id });
  await audit(req, 'delete_server', s.name, `ptero ${s.pteroId}.${refunded}`);
  req.flash('success', 'Server deleted' + (refunded ? ' and coins refunded.' : '.'));
  res.redirect('/admin/servers');
}));

// ---------- coin orders ----------
router.get('/orders', wrap(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : '';
  const orders = await CoinOrder.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(300).populate('user', 'name email');
  res.render('admin/orders', { active: 'orders', orders, status });
}));

router.post('/orders/:id/approve', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
  // claim the order atomically so it can never be approved twice
  const order = await CoinOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { status: 'approved', adminNote, reviewedBy: req.user._id, reviewedAt: new Date() }
  );
  if (!order) { req.flash('error', 'Order not found or already reviewed.'); return res.redirect('/admin/orders'); }
  try {
    await wallet.creditCoins(order.user, order.coins, 'Coin request approved', { orderId: String(order._id), note: order.note, adminId: String(req.user._id) });
    await audit(req, 'approve_order', String(order._id), `${order.coins} coins`);
    req.flash('success', `Approved: ${order.coins} coins added.`);
  } catch (e) {
    await CoinOrder.updateOne({ _id: order._id }, { status: 'pending', reviewedBy: null, reviewedAt: null });
    throw e;
  }
  res.redirect('/admin/orders');
}));

router.post('/orders/:id/reject', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const adminNote = String(req.body.adminNote || '').trim().slice(0, 300);
  const order = await CoinOrder.findOneAndUpdate(
    { _id: req.params.id, status: 'pending' },
    { status: 'rejected', adminNote, reviewedBy: req.user._id, reviewedAt: new Date() }
  );
  if (order) await audit(req, 'reject_order', String(order._id), `${order.coins} coins. ${adminNote}`);
  req.flash(order ? 'success' : 'error', order ? 'Order rejected.' : 'Order not found or already reviewed.');
  res.redirect('/admin/orders');
}));

// ---------- Zip Bots (MediaFire links shared with customers: FREE or VIP) ----------
function cleanUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try { const u = new URL(s); if (u.protocol === 'https:' || u.protocol === 'http:') return s.slice(0, 700); } catch (e) { /* invalid */ }
  return null;
}
function parseBot(b) {
  const title = String(b.title || '').trim();
  if (!title || title.length > 80) return { error: 'Bot name is required (max 80 chars).' };
  const type = b.type === 'vip' ? 'vip' : 'free';
  const link = cleanUrl(b.link);
  if (!link) return { error: 'The download link (MediaFire) is required and must start with https://' };
  const imageUrl = cleanUrl(b.imageUrl); const videoUrl = cleanUrl(b.videoUrl);
  if (imageUrl === null) return { error: 'Image URL is not valid (must start with https://).' };
  if (videoUrl === null) return { error: 'Video URL is not valid (must start with https://).' };
  const coins = Number(b.coins || 0);
  if (!Number.isInteger(coins) || coins < 0 || coins > 100000000) return { error: 'VIP coins must be a whole number >= 0.' };
  const m = parseMoney(b);
  if (m.error) return m;
  if (type === 'vip' && coins < 1 && !(m.priceTZS > 0) && !Object.keys(m.prices).length) return { error: 'A VIP bot needs a price: coins and/or money.' };
  return { bot: { title, description: String(b.description || '').trim().slice(0, 1500), type, link, imageUrl, videoUrl, coins: type === 'vip' ? coins : 0, priceTZS: type === 'vip' ? m.priceTZS : 0, prices: type === 'vip' ? m.prices : {} } };
}

router.get('/bots', wrap(async (req, res) => {
  const bots = await BotZip.find().sort({ createdAt: -1 }).lean();
  const sold = await BotAccess.aggregate([{ $group: { _id: '$bot', n: { $sum: 1 } } }]);
  const soldMap = {}; sold.forEach((s) => { soldMap[String(s._id)] = s.n; });
  res.render('admin/bots', { active: 'bots', bots, soldMap });
}));
router.post('/bots', wrap(async (req, res) => {
  const r = parseBot(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/bots'); }
  const bot = await BotZip.create(r.bot);
  await audit(req, 'create_bot', bot.title, bot.type);
  req.flash('success', 'Bot added.');
  res.redirect('/admin/bots');
}));
router.post('/bots/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const r = parseBot(req.body);
  if (r.error) { req.flash('error', r.error); return res.redirect('/admin/bots'); }
  r.bot.active = req.body.active === '1';
  await BotZip.updateOne({ _id: req.params.id }, { $set: r.bot });
  await audit(req, 'edit_bot', r.bot.title, r.bot.type);
  req.flash('success', 'Bot updated.');
  res.redirect('/admin/bots');
}));
router.post('/bots/:id/toggle', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const b = await BotZip.findById(req.params.id);
  if (b) { b.active = !b.active; await b.save(); }
  res.redirect('/admin/bots');
}));
router.post('/bots/:id/delete', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const b = await BotZip.findByIdAndDelete(req.params.id);
  if (b) { await BotAccess.deleteMany({ bot: b._id }); await audit(req, 'delete_bot', b.title, b.type); }
  req.flash('success', 'Bot deleted.');
  res.redirect('/admin/bots');
}));

// ---------- offers (private deals for one customer, chosen by email) ----------
router.get('/offers', wrap(async (req, res) => {
  const [list, plans] = await Promise.all([
    Offer.find().sort({ createdAt: -1 }).limit(300).populate('user', 'name email').populate('plan', 'name coins'),
    Plan.find({ kind: { $ne: 'admin' }, active: true }).sort({ coins: 1 }).lean()
  ]);
  res.render('admin/offers', { active: 'offers', list, plans });
}));

router.post('/offers', wrap(async (req, res) => {
  const b = req.body; const back = '/admin/offers';
  const email = String(b.email || '').trim().toLowerCase();
  const user = email ? await User.findOne({ email }) : null;
  if (!user) { req.flash('error', 'No customer found with this email.'); return res.redirect(back); }
  if (!validId(b.plan)) { req.flash('error', 'Choose a plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: b.plan, kind: { $ne: 'admin' } });
  if (!plan) { req.flash('error', 'Plan not found.'); return res.redirect(back); }
  const coins = String(b.coins || '').trim() === '' ? plan.coins : Number(b.coins);
  const gift = Number(b.giftCoins || 0);
  const days = Number(b.days || 0);
  const serverDays = Number(b.serverDays || 0);
  if (!Number.isInteger(serverDays) || serverDays < 0 || serverDays > 3650) { req.flash('error', 'Server duration must be a whole number of days >= 0 (0 = never expires).'); return res.redirect(back); }
  if (!Number.isInteger(coins) || coins < 0 || coins > 100000000) { req.flash('error', 'Offer coins must be a whole number >= 0 (0 = free).'); return res.redirect(back); }
  if (!Number.isInteger(gift) || gift < 0 || gift > 100000000) { req.flash('error', 'Gift coins must be a whole number >= 0.'); return res.redirect(back); }
  if (!Number.isInteger(days) || days < 0 || days > 3650) { req.flash('error', 'Days must be a whole number >= 0 (0 = no expiry).'); return res.redirect(back); }
  const m = parseMoney(b);
  if (m.error) { req.flash('error', m.error); return res.redirect(back); }
  const offer = await Offer.create({
    user: user._id, plan: plan._id, planName: plan.name, coins, priceTZS: m.priceTZS, prices: m.prices, giftCoins: gift, serverDays,
    note: String(b.note || '').trim().slice(0, 200), expiresAt: days > 0 ? new Date(Date.now() + days * 86400000) : null, createdBy: req.user._id
  });
  if (gift > 0) await wallet.creditCoins(user._id, gift, 'Gift from admin (offer: ' + plan.name + ')', { offer: String(offer._id), adminId: String(req.user._id) });
  await audit(req, 'create_offer', user.email, `${plan.name} for ${coins} coins${gift ? ' + gift ' + gift + ' coins' : ''}`);
  req.flash('success', 'Offer sent to ' + user.email + (gift ? ' (' + gift + ' coins added to their balance)' : '') + '.');
  res.redirect(back);
}));

router.post('/offers/:id/cancel', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const o = await Offer.findOneAndUpdate({ _id: req.params.id, status: 'active' }, { $set: { status: 'cancelled' } });
  if (o) await audit(req, 'cancel_offer', String(o._id), o.planName);
  req.flash(o ? 'success' : 'error', o ? 'Offer cancelled.' : 'Offer not found or already used.');
  res.redirect('/admin/offers');
}));

// ---------- automatic payments (FimiPay) ----------
router.get('/payments', wrap(async (req, res) => {
  const status = ['pending', 'paid', 'failed', 'cancelled', 'expired'].includes(req.query.status) ? req.query.status : '';
  const list = await PaymentOrder.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(300).populate('user', 'name email');
  res.render('admin/payments', { active: 'payments', list, status });
}));
router.post('/payments/:id/sync', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const o = await PaymentOrder.findById(req.params.id);
  if (!o) return notFound(res);
  try {
    const r = await payments.sync(o);
    if (r && r.status === 'paid' && !r.fulfilled) await payments.fulfil(r._id);
    req.flash('success', 'Payment re-checked.');
  } catch (e) { console.error('admin payment sync failed', e.message); req.flash('error', 'Could not reach FimiPay. Try again.'); }
  res.redirect('/admin/payments');
}));

// ---------- transactions & logs ----------
router.get('/transactions', wrap(async (req, res) => {
  const type = ['credit', 'debit', 'refund'].includes(req.query.type) ? req.query.type : '';
  const transactions = await Transaction.find(type ? { type } : {}).sort({ createdAt: -1 }).limit(500).populate('user', 'name email');
  res.render('admin/transactions', { active: 'transactions', transactions, type });
}));

router.get('/logs', wrap(async (req, res) => {
  res.render('admin/logs', { active: 'logs', logs: await AuditLog.find().sort({ createdAt: -1 }).limit(300) });
}));

// ---------- notifications ----------
router.get('/notifications', wrap(async (req, res) => {
  res.render('admin/notifications', { active: 'notifications', items: await Notification.find().sort({ createdAt: -1 }).limit(200).lean() });
}));
router.post('/notifications', wrap(async (req, res) => {
  const title = String(req.body.title || '').trim();
  const message = String(req.body.message || '').trim();
  const type = ['info', 'success', 'warning'].includes(req.body.type) ? req.body.type : 'info';
  if (title.length < 2 || title.length > 80) { req.flash('error', 'Title must be 2-80 characters.'); return res.redirect('/admin/notifications'); }
  if (message.length < 2 || message.length > 600) { req.flash('error', 'Message must be 2-600 characters.'); return res.redirect('/admin/notifications'); }
  await Notification.create({ title, message, type, createdBy: req.user._id });
  await audit(req, 'add_notification', title, '');
  req.flash('success', 'Notification sent to all members.');
  res.redirect('/admin/notifications');
}));
router.post('/notifications/:id/delete', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const n = await Notification.findByIdAndDelete(req.params.id);
  if (n) await audit(req, 'delete_notification', n.title, '');
  req.flash(n ? 'success' : 'error', n ? 'Notification deleted.' : 'Notification not found.');
  res.redirect('/admin/notifications');
}));

// ---------- settings ----------
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    active: 'settings',
    pteroConfigured: ptero.isConfigured(),
    pteroUrl: process.env.PTERODACTYL_URL || '(not set)',
    pteroKey: ptero.maskedKey(),
    panelUrlSaved: res.locals.site.panelUrl || '',
    ids: { nest: process.env.PTERODACTYL_NEST_ID, egg: process.env.PTERODACTYL_EGG_ID, location: process.env.PTERODACTYL_LOCATION_ID },
    mongoConnected: mongoose.connection.readyState === 1
  });
});

router.post('/settings', wrap(async (req, res) => {
  const b = req.body;
  const siteName = String(b.siteName || '').trim();
  const supportLink = String(b.supportLink || '').trim();
  if (siteName.length < 2 || siteName.length > 40) { req.flash('error', 'Site name must be 2-40 characters.'); return res.redirect('/admin/settings'); }
  if (supportLink && !/^https?:\/\/\S+$/.test(supportLink)) { req.flash('error', 'Support link must start with http:// or https://'); return res.redirect('/admin/settings'); }
  const panelUrl = String(b.panelUrl || '').trim().replace(/\/+$/, '');
  if (panelUrl && !/^https?:\/\/\S+$/.test(panelUrl)) { req.flash('error', 'Panel link must start with http:// or https://'); return res.redirect('/admin/settings'); }
  const coinPriceTZS = Number(b.coinPriceTZS || 0);
  if (!Number.isInteger(coinPriceTZS) || coinPriceTZS < 0 || coinPriceTZS > 100000000) { req.flash('error', 'Coin price must be a whole number of TZS (0 = use .env).'); return res.redirect('/admin/settings'); }
  const payRates = String(b.payRates || '').replace(/\s+/g, '').slice(0, 300);
  if (payRates && !/^([A-Za-z]{3}:\d+(\.\d+)?)(,[A-Za-z]{3}:\d+(\.\d+)?)*$/.test(payRates)) { req.flash('error', 'Rates format: KES:0.05,UGX:1.4,NGN:0.6'); return res.redirect('/admin/settings'); }
  const coinPrices = {};
  for (const cur of ['KES','UGX','NGN','GHS','XAF','ZAR']) {
    const raw = String(b['coinPrice_' + cur] || '').trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!(n > 0) || n > 100000000) { req.flash('error', 'Coin price ' + cur + ' must be a number > 0 (or empty = automatic).'); return res.redirect('/admin/settings'); }
    coinPrices[cur] = n;
  }
  await Setting.getMain();
  await Setting.updateOne({ key: 'main' }, {
    siteName, supportLink, panelUrl, coinPriceTZS, payRates, coinPrices,
    maintenance: b.maintenance === 'on',
    registrationOpen: b.registrationOpen === 'on',
    paymentInfo: String(b.paymentInfo || '').trim().slice(0, 600),
    announcement: {
      text: String(b.annText || '').trim().slice(0, 300),
      type: ['info', 'success', 'warning'].includes(b.annType) ? b.annType : 'info',
      active: b.annActive === 'on'
    }
  });
  await audit(req, 'update_settings', 'site', `maintenance=${b.maintenance === 'on'} registration=${b.registrationOpen === 'on'}`);
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

module.exports = router;
