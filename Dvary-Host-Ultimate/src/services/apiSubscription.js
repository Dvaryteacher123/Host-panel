// Everything about the paid DVARY API subscription: activation (only after a CONFIRMED payment), keys, limits, permissions.
const crypto = require('crypto');
const ApiPlan = require('../models/ApiPlan');
const ApiSubscription = require('../models/ApiSubscription');
const ApiKey = require('../models/ApiKey');
const ApiUsage = require('../models/ApiUsage');
const Server = require('../models/Server');

const DAY = 86400000;
const sha = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
exports.hashKey = sha;
exports.today = () => new Date().toISOString().slice(0, 10);

// 'none' | 'active' | 'expired' | 'suspended'
exports.state = (sub) => {
  if (!sub) return 'none';
  if (sub.suspended) return 'suspended';
  if (new Date(sub.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
};
exports.daysLeft = (sub) => (sub ? Math.max(0, Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / DAY)) : 0);

const LIMIT_KEYS = ['maxServers', 'maxRequestsPerDay', 'maxRequestsPerMinute', 'maxRamMB', 'maxDiskMB', 'maxCpu'];
exports.LIMIT_KEYS = LIMIT_KEYS;

// package default + the admin's per-customer overrides
exports.limitsFor = (plan, sub) => {
  const out = {};
  const base = (plan && plan.limits && (plan.limits.toObject ? plan.limits.toObject() : plan.limits)) || {};
  const over = (sub && sub.limitOverrides) || {};
  LIMIT_KEYS.forEach((k) => {
    const o = over[k];
    out[k] = (o !== undefined && o !== null && o !== '' && Number.isFinite(Number(o))) ? Number(o) : Number(base[k] || 0);
  });
  return out;
};

// permissions = what the package allows, or the admin's override for this customer
exports.permsFor = (plan, sub) => {
  const list = (sub && Array.isArray(sub.permissionsOverride)) ? sub.permissionsOverride : (plan.permissions || []);
  return list.filter((p) => ApiPlan.PERMS[p]);
};

// Called when a payment is CONFIRMED (status paid) - or by the admin. Safe to call twice for the same payment.
// Renewal while still active adds the days at the end; after expiry a new 30-day period starts today.
exports.activate = async ({ userId, days, orderId, amount, currency, priceTZS, source }) => {
  const plan = await ApiPlan.getMain();
  const d = Number(days) > 0 ? Number(days) : plan.durationDays;
  let sub = await ApiSubscription.findOne({ user: userId });
  const now = new Date();
  if (sub && orderId && (sub.payments || []).some((p) => String(p.order) === String(orderId))) return sub;   // already applied
  const entry = { order: orderId || undefined, at: now, days: d, amount: Number(amount) || 0, currency: currency || 'TZS', source: source || 'payment' };
  if (!sub) {
    try {
      sub = await ApiSubscription.create({ user: userId, planName: plan.name, priceTZS: Number(priceTZS) || plan.priceTZS, paidAmount: Number(amount) || 0, paidCurrency: currency || 'TZS', status: 'active', startedAt: now, expiresAt: new Date(now.getTime() + d * DAY), payments: [entry] });
      return sub;
    } catch (e) { if (!(e && e.code === 11000)) throw e; sub = await ApiSubscription.findOne({ user: userId }); }
  }
  const stillActive = new Date(sub.expiresAt).getTime() > now.getTime();
  const from = stillActive ? new Date(sub.expiresAt) : now;
  const set = { planName: plan.name, priceTZS: Number(priceTZS) || plan.priceTZS, paidAmount: Number(amount) || sub.paidAmount || 0, paidCurrency: currency || sub.paidCurrency || 'TZS', expiresAt: new Date(from.getTime() + d * DAY), status: sub.suspended ? 'suspended' : 'active' };
  if (!stillActive) set.startedAt = now;
  return ApiSubscription.findOneAndUpdate({ _id: sub._id }, { $set: set, $push: { payments: entry } }, { new: true });
};

exports.extend = (subId, days) => ApiSubscription.findById(subId).then((sub) => {
  if (!sub) return null;
  const from = new Date(sub.expiresAt).getTime() > Date.now() ? new Date(sub.expiresAt) : new Date();
  sub.expiresAt = new Date(from.getTime() + Number(days) * DAY);
  if (!sub.suspended) sub.status = 'active';
  sub.payments.push({ at: new Date(), days: Number(days), amount: 0, currency: 'TZS', source: 'admin' });
  return sub.save();
});

// Generates a NEW key (the old active key of this customer stops working). The plain key is returned once and never stored.
exports.generateKey = async (sub, { name, appUrl, appDescription } = {}) => {
  await ApiKey.updateMany({ subscription: sub._id, status: 'active' }, { $set: { status: 'revoked', revoked: true, revokedAt: new Date() } });
  const key = 'dvary_live_' + crypto.randomBytes(20).toString('hex');
  const rec = await ApiKey.create({
    user: sub.user, subscription: sub._id, name: String(name || 'My app').slice(0, 40), appUrl: String(appUrl || '').slice(0, 200), appDescription: String(appDescription || '').slice(0, 200),
    prefix: key.slice(0, 15), hash: sha(key), status: 'active'
  });
  return { key, rec };
};
exports.revokeKeys = (subId) => ApiKey.updateMany({ subscription: subId, status: 'active' }, { $set: { status: 'revoked', revoked: true, revokedAt: new Date() } });

exports.serversUsed = (userId) => Server.countDocuments({ user: userId, createdVia: 'api', status: { $in: ['pending', 'active', 'suspended'] } });
exports.requestsToday = async (subId) => {
  const u = await ApiUsage.findOne({ subscription: subId, day: exports.today() }).lean();
  return u ? u.requests : 0;
};

// marks finished subscriptions as expired (the real check on every request uses expiresAt, so this is only for the lists)
exports.sweep = async () => {
  try { await ApiSubscription.updateMany({ suspended: false, status: 'active', expiresAt: { $lte: new Date() } }, { $set: { status: 'expired' } }); }
  catch (e) { console.error('[api] sweep failed', e.message); }
};

// readable price list of a package, one entry per country price the admin typed
exports.priceText = (plan) => {
  const parts = [];
  if (Number(plan.priceTZS) > 0) parts.push('TZS ' + Number(plan.priceTZS).toLocaleString('en-US'));
  Object.keys(plan.prices || {}).forEach((c) => { if (Number(plan.prices[c]) > 0) parts.push(c + ' ' + Number(plan.prices[c]).toLocaleString('en-US')); });
  return parts.join(' · ') || 'price not set';
};
