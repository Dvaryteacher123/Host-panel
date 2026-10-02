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
const Setting = require('../models/Setting');
const AuditLog = require('../models/AuditLog');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
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
  u.banned = !u.banned;
  await u.save();
  await audit(req, u.banned ? 'ban_user' : 'unban_user', u.email, '');
  req.flash('success', u.banned ? 'User suspended.' : 'User restored.');
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
function parsePlan(b) {
  const int = (v) => Number(v);
  const p = {
    name: String(b.name || '').trim(), description: String(b.description || '').trim().slice(0, 300),
    coins: int(b.coins), memory: int(b.memory), disk: int(b.disk), cpu: int(b.cpu),
    databases: int(b.databases || 0), backups: int(b.backups || 0), active: b.active === 'on',
    nestId: Number(b.nestId) > 0 ? Number(b.nestId) : null, eggId: Number(b.eggId) > 0 ? Number(b.eggId) : null,
    dockerImage: String(b.dockerImage || '').trim().slice(0, 200), startup: String(b.startup || '').trim().slice(0, 500),
    eggName: String(b.eggName || '').trim().slice(0, 80), imageLabel: String(b.imageLabel || '').trim().slice(0, 80)
  };
  const okInt = (n, min) => Number.isInteger(n) && n >= min;
  if (!p.name || p.name.length > 60) return { error: 'Plan name is required (max 60 chars).' };
  if (!okInt(p.coins, 1)) return { error: 'Coin price must be a whole number >= 1.' };
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

router.get('/plans', wrap(async (req, res) => {
  res.render('admin/plans', { active: 'plans', plans: await Plan.find().sort({ coins: 1 }) });
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

// ---------- transactions & logs ----------
router.get('/transactions', wrap(async (req, res) => {
  const type = ['credit', 'debit', 'refund'].includes(req.query.type) ? req.query.type : '';
  const transactions = await Transaction.find(type ? { type } : {}).sort({ createdAt: -1 }).limit(500).populate('user', 'name email');
  res.render('admin/transactions', { active: 'transactions', transactions, type });
}));

router.get('/logs', wrap(async (req, res) => {
  res.render('admin/logs', { active: 'logs', logs: await AuditLog.find().sort({ createdAt: -1 }).limit(300) });
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
  await Setting.getMain();
  await Setting.updateOne({ key: 'main' }, {
    siteName, supportLink, panelUrl,
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
