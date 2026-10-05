// Admin: DVARY API subscribers, settings (price / days / limits / permissions), logs and payments
const express = require('express');
const mongoose = require('mongoose');
const ApiPlan = require('../models/ApiPlan');
const ApiSubscription = require('../models/ApiSubscription');
const ApiKey = require('../models/ApiKey');
const ApiLog = require('../models/ApiLog');
const PaymentOrder = require('../models/PaymentOrder');
const User = require('../models/User');
const audit = require('../services/auditService');
const subSvc = require('../services/apiSubscription');
const pricing = require('../services/pricing');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; };

async function list(req, res, extra) {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const st = String(req.query.st || '');
  const filter = {};
  if (q) {
    const rx = new RegExp(esc(q), 'i');
    const users = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').limit(300).lean();
    filter.user = { $in: users.map((u) => u._id) };
  }
  const now = new Date();
  if (st === 'active') Object.assign(filter, { suspended: false, expiresAt: { $gt: now } });
  else if (st === 'expired') Object.assign(filter, { suspended: false, expiresAt: { $lte: now } });
  else if (st === 'suspended') filter.suspended = true;
  const [plan, subs, total, nActive, nSusp] = await Promise.all([
    ApiPlan.getMain(),
    ApiSubscription.find(filter).sort({ createdAt: -1 }).limit(200).populate('user', 'name email banned').lean(),
    ApiSubscription.countDocuments(), ApiSubscription.countDocuments({ suspended: false, expiresAt: { $gt: now } }), ApiSubscription.countDocuments({ suspended: true })
  ]);
  const ids = subs.map((s) => s._id), uids = subs.map((s) => s.user && s.user._id).filter(Boolean);
  const [keys, revokedIds, pays, used] = await Promise.all([
    ApiKey.find({ subscription: { $in: ids }, status: 'active' }).lean(),
    ApiKey.distinct('subscription', { subscription: { $in: ids }, status: 'revoked' }),
    PaymentOrder.aggregate([{ $match: { kind: 'api', user: { $in: uids } } }, { $sort: { createdAt: -1 } }, { $group: { _id: '$user', status: { $first: '$status' }, amount: { $first: '$amount' }, currency: { $first: '$currency' } } }]),
    require('../models/Server').aggregate([{ $match: { createdVia: 'api', user: { $in: uids }, status: { $in: ['pending', 'active', 'suspended'] } } }, { $group: { _id: '$user', n: { $sum: 1 } } }])
  ]);
  const keyMap = {}; keys.forEach((k) => { keyMap[String(k.subscription)] = k; });
  const revSet = new Set(revokedIds.map(String));
  const payMap = {}; pays.forEach((p) => { payMap[String(p._id)] = p; });
  const usedMap = {}; used.forEach((u) => { usedMap[String(u._id)] = u.n; });
  res.render('admin/api', Object.assign({ active: 'apikeys', tab: 'subs', pageTitle: 'DVARY API', plan, subs, q, st, keyMap, revSet, payMap, usedMap, subSvc, PERMS: ApiPlan.PERMS, totals: { total, active: nActive, suspended: nSusp }, newKey: '', newKeyFor: '' }, extra || {}));
}

router.get('/api', wrap((req, res) => list(req, res)));

// manual activation (e.g. cash payment): same effect as a confirmed payment, marked "admin" in the history
router.post('/api/activate', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = email ? await User.findOne({ email }) : null;
  if (!user) { req.flash('error', 'No user with this email.'); return res.redirect('/admin/api'); }
  const plan = await ApiPlan.getMain();
  const days = Math.min(3650, Math.max(1, int(req.body.days, plan.durationDays)));
  await subSvc.activate({ userId: user._id, days, source: 'admin', amount: 0 });
  await audit(req, 'api_activate', user.email, days + ' days');
  req.flash('success', `API subscription activated for ${user.email} (+${days} days).`);
  res.redirect('/admin/api');
}));

const withSub = (fn) => wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.redirect('/admin/api');
  const sub = await ApiSubscription.findById(req.params.id);
  if (!sub) { req.flash('error', 'Subscription not found.'); return res.redirect('/admin/api'); }
  return fn(req, res, sub);
});

router.post('/api/:id/suspend', withSub(async (req, res, sub) => {
  const on = !sub.suspended;
  sub.suspended = on; sub.suspendNote = on ? String(req.body.note || '').slice(0, 200) : '';
  sub.status = on ? 'suspended' : (new Date(sub.expiresAt) > new Date() ? 'active' : 'expired');
  await sub.save();
  await audit(req, on ? 'api_suspend' : 'api_unsuspend', String(sub.user), sub.suspendNote);
  req.flash('success', on ? 'API access suspended. Requests are rejected now.' : 'API access restored.');
  res.redirect('/admin/api');
}));

router.post('/api/:id/revoke', withSub(async (req, res, sub) => {
  await subSvc.revokeKeys(sub._id);
  await audit(req, 'api_revoke_key', String(sub.user), '');
  req.flash('success', 'API key revoked.');
  res.redirect('/admin/api');
}));

router.post('/api/:id/regenerate', withSub(async (req, res, sub) => {
  if (subSvc.state(sub) !== 'active') { req.flash('error', 'Only an active subscription can have a key.'); return res.redirect('/admin/api'); }
  const { key } = await subSvc.generateKey(sub, { name: 'Generated by admin' });
  await audit(req, 'api_regenerate_key', String(sub.user), '');
  const u = await User.findById(sub.user).select('email').lean();
  return list(req, res, { newKey: key, newKeyFor: u ? u.email : '' });
}));

router.post('/api/:id/extend', withSub(async (req, res, sub) => {
  const days = Math.min(3650, Math.max(1, int(req.body.days, 0)));
  await subSvc.extend(sub._id, days);
  await audit(req, 'api_extend', String(sub.user), '+' + days + ' days');
  req.flash('success', `Expiry extended by ${days} days.`);
  res.redirect('/admin/api');
}));

router.post('/api/:id/limits', withSub(async (req, res, sub) => {
  const over = {};
  subSvc.LIMIT_KEYS.forEach((k) => { const raw = String(req.body[k] || '').trim(); if (raw !== '' && Number.isFinite(Number(raw)) && Number(raw) >= 0) over[k] = Math.floor(Number(raw)); });
  sub.limitOverrides = over; sub.markModified('limitOverrides');
  if (req.body.permMode === 'custom') sub.permissionsOverride = Object.keys(ApiPlan.PERMS).filter((p) => req.body['perm_' + p] === 'on');
  else sub.permissionsOverride = undefined;
  await sub.save();
  await audit(req, 'api_limits', String(sub.user), JSON.stringify(over));
  req.flash('success', 'Limits & permissions saved for this customer.');
  res.redirect('/admin/api');
}));

// ---------- settings: price, days, limits, permissions ----------
router.get('/api/settings', wrap(async (req, res) => {
  res.render('admin/api-settings', { active: 'apikeys', tab: 'settings', pageTitle: 'API Settings', plan: await ApiPlan.getMain(), PERMS: ApiPlan.PERMS });
}));

router.post('/api/settings', wrap(async (req, res) => {
  const b = req.body;
  const pr = pricing.parse(b), days = int(b.durationDays, 0);
  if (!pricing.any(pr) || days < 1 || days > 3650) { req.flash('error', 'Type a price for at least one country and a duration of 1-3650 days.'); return res.redirect('/admin/api/settings'); }
  const lim = { maxServers: int(b.maxServers, 20), maxRequestsPerDay: int(b.maxRequestsPerDay, 0), maxRequestsPerMinute: int(b.maxRequestsPerMinute, 60), maxRamMB: int(b.maxRamMB, 2048), maxDiskMB: int(b.maxDiskMB, 5120), maxCpu: int(b.maxCpu, 0) };
  if (lim.maxServers < 0 || lim.maxRequestsPerDay < 0 || lim.maxRequestsPerMinute < 1 || lim.maxRamMB < 64 || lim.maxDiskMB < 64 || lim.maxCpu < 0) { req.flash('error', 'One of the limits is not valid (RAM and disk at least 64, requests per minute at least 1).'); return res.redirect('/admin/api/settings'); }
  const eggs = String(b.allowedEggs || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (eggs.some((l) => !/^\d+\s*:\s*\d+$/.test(l))) { req.flash('error', 'Allowed eggs: one per line as nestId:eggId, e.g. 5:12'); return res.redirect('/admin/api/settings'); }
  const plan = await ApiPlan.getMain();
  plan.name = String(b.name || 'DVARY API PRO').trim().slice(0, 60) || 'DVARY API PRO';
  plan.priceTZS = pr.priceTZS; plan.durationDays = days; plan.active = b.active === 'on'; plan.prices = pr.prices; plan.markModified('prices');
  plan.features = String(b.features || '').split(/\r?\n/).map((l) => l.trim().slice(0, 80)).filter(Boolean).slice(0, 12);
  plan.limits = lim;
  plan.permissions = Object.keys(ApiPlan.PERMS).filter((p) => b['perm_' + p] === 'on');
  plan.allowedEggs = eggs.join('\n');
  await plan.save();
  await audit(req, 'api_settings', plan.name, `${JSON.stringify(Object.assign({ TZS: pr.priceTZS }, pr.prices))} / ${days} days`);
  req.flash('success', 'API package saved. New payments and requests use the new values.');
  res.redirect('/admin/api/settings');
}));

router.get('/api/logs', wrap(async (req, res) => {
  const filter = {};
  if (validId(req.query.sub)) filter.subscription = req.query.sub;
  const code = String(req.query.status || '');
  if (code === 'errors') filter.status = { $gte: 400 };
  const logs = await ApiLog.find(filter).sort({ createdAt: -1 }).limit(300).populate('user', 'email').lean();
  res.render('admin/api-logs', { active: 'apikeys', tab: 'logs', pageTitle: 'API Logs', logs, sub: String(req.query.sub || ''), status: code });
}));

router.get('/api/payments', wrap(async (req, res) => {
  const orders = await PaymentOrder.find({ kind: 'api' }).sort({ createdAt: -1 }).limit(300).populate('user', 'email name').lean();
  res.render('admin/api-payments', { active: 'apikeys', tab: 'pays', pageTitle: 'API Payments', orders });
}));

module.exports = router;
