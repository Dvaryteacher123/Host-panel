// DVARY public REST API  ->  /api/v1/...
// Every request passes the SAME chain (nothing reaches Pterodactyl before all checks are green):
//  1 key present  2 key valid  3 not revoked  4 subscription active  5 not expired  6 permission  7 limits  8 then the action
const express = require('express');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const ApiPlan = require('../models/ApiPlan');
const ApiSubscription = require('../models/ApiSubscription');
const ApiUsage = require('../models/ApiUsage');
const ApiLog = require('../models/ApiLog');
const User = require('../models/User');
const Server = require('../models/Server');
const Setting = require('../models/Setting');
const ptero = require('../services/pterodactylService');
const subSvc = require('../services/apiSubscription');
const apiServers = require('../services/apiServers');
const portGuard = require('../services/portGuard');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

// ---- response helpers: { success: true, ... }  /  { success: false, error, message } ----
const ok = (res, payload, status) => res.status(status || 200).json(Object.assign({ success: true }, payload || {}));
const err = (res, status, error, message, code) => { res.locals.apiError = error; return res.status(status).json({ success: false, error, message, code: code || undefined }); };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  if (e && e.code && e.status) return err(res, e.status, e.message, e.message, e.code);
  console.error('[api]', e && e.message); err(res, 500, 'Server error', 'Something went wrong. Please try again.');
});

// the key is the login (no cookies) -> any website / script may call the API
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// per-minute limiter (per key)
const hits = new Map();
function perMinute(id, max) {
  const now = Date.now(); const h = hits.get(id) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++; hits.set(id, h);
  if (hits.size > 5000) hits.clear();
  return h.n > max ? Math.ceil((60000 - (now - h.t)) / 1000) : 0;
}

router.use(wrap(async (req, res, next) => {
  // 1. key present
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const key = m ? m[1] : String(req.get('x-api-key') || '').trim();
  if (!key) return err(res, 401, 'API key missing', 'Send your key as: Authorization: Bearer DVARY_API_KEY');
  // 2. key valid
  const rec = /^dvary_live_[a-f0-9]{40}$/.test(key) ? await ApiKey.findOne({ hash: subSvc.hashKey(key) }) : null;
  if (!rec) return err(res, 401, 'Invalid API key', 'This API key does not exist.');
  // 3. not revoked
  if (rec.status === 'revoked') return err(res, 401, 'API key revoked', 'This key was revoked. Generate a new one in your dashboard.');
  // 4 + 5. subscription active and not expired
  const sub = await ApiSubscription.findById(rec.subscription);
  if (!sub) return err(res, 403, 'No subscription', 'This key has no active subscription.');
  const user = await User.findById(sub.user).select('-password');
  if (!user || user.banned) return err(res, 403, 'Account disabled', 'This account is disabled.');
  const st = subSvc.state(sub);
  if (st === 'suspended') return err(res, 403, 'API key suspended', 'Your API access was suspended. Contact support.');
  if (st === 'expired') return err(res, 403, 'API key expired', 'Please renew your DVARY API subscription.');
  const site = await Setting.getMain();
  if (site.maintenance && user.role !== 'admin') return err(res, 503, 'Maintenance', 'We are under maintenance. Please try again later.');

  // 7a. request limits (per minute and per day) - set by the admin
  const plan = await ApiPlan.getMain();
  const limits = subSvc.limitsFor(plan, sub);
  const wait = perMinute(String(rec._id), limits.maxRequestsPerMinute || 60);
  if (wait) { res.setHeader('Retry-After', wait); return err(res, 429, 'Too many requests', `Rate limit reached. Try again in ${wait}s.`); }
  const day = await ApiUsage.findOneAndUpdate({ subscription: sub._id, day: subSvc.today() }, { $inc: { requests: 1 } }, { upsert: true, new: true });
  if (limits.maxRequestsPerDay > 0 && day.requests > limits.maxRequestsPerDay) return err(res, 429, 'Daily limit reached', `Your plan allows ${limits.maxRequestsPerDay} requests per day.`);

  req.ctx = { key: rec, sub, user, plan, limits, perms: subSvc.permsFor(plan, sub) };
  req.user = user;
  // usage counters + log line (after the response is sent)
  const t0 = Date.now(), ip = String(req.ip || '').slice(0, 60);
  res.on('finish', () => {
    const now = new Date();
    ApiKey.updateOne({ _id: rec._id }, { $inc: { uses: 1 }, $set: { lastUsedAt: now, lastIp: ip } }).catch(() => {});
    ApiSubscription.updateOne({ _id: sub._id }, { $inc: { totalRequests: 1 }, $set: { lastRequestAt: now } }).catch(() => {});
    ApiLog.create({ user: user._id, subscription: sub._id, keyPrefix: rec.prefix, method: req.method, path: String(req.originalUrl).split('?')[0].slice(0, 200), status: res.statusCode, ms: Date.now() - t0, ip, error: res.locals.apiError || '' }).catch(() => {});
  });
  next();
}));

// 6. permission check
const need = (perm) => (req, res, next) => (req.ctx.perms.includes(perm) ? next() : err(res, 403, 'Permission denied', `Your API key does not have the "${perm}" permission.`, 'FORBIDDEN'));

const maskPhone = (p) => (p && p.length > 6 ? p.slice(0, 3) + '*****' + p.slice(-2) : '');
const subDto = (ctx) => ({ plan: ctx.sub.planName, status: subSvc.state(ctx.sub), startedAt: ctx.sub.startedAt, expiresAt: ctx.sub.expiresAt, daysRemaining: subSvc.daysLeft(ctx.sub) });
const serverDto = (s) => ({ id: String(s._id), name: s.name, status: s.status, identifier: s.identifier || null, port: s.port || null, memoryMB: s.resources && s.resources.memory, diskMB: s.resources && s.resources.disk, cpuPercent: s.resources && s.resources.cpu, createdAt: s.createdAt });
const apiServer = (req) => (validId(req.params.id) ? Server.findOne({ _id: req.params.id, user: req.user._id, createdVia: 'api' }) : Promise.resolve(null));
const notFound = (res, what) => err(res, 404, 'Not found', `${what || 'Server'} not found.`);

// ======================= account =======================
router.get('/me', wrap(async (req, res) => ok(res, { user: { id: String(req.user._id), name: req.user.name, email: req.user.email }, subscription: subDto(req.ctx), permissions: req.ctx.perms })));

router.get('/resources', need('resources.read'), wrap(async (req, res) => {
  const c = req.ctx;
  ok(res, {
    subscription: subDto(c), limits: c.limits, permissions: c.perms,
    usage: { requestsToday: await subSvc.requestsToday(c.sub._id), serversUsed: await subSvc.serversUsed(c.user._id), serversCreatedTotal: c.sub.serversCreated, totalRequests: c.sub.totalRequests }
  });
}));

// ======================= servers (Pterodactyl, through our backend) =======================
router.get('/servers', need('servers.read'), wrap(async (req, res) => {
  const list = await Server.find({ user: req.user._id, createdVia: 'api' }).sort({ createdAt: -1 }).limit(200).lean();
  ok(res, { servers: list.map(serverDto) });
}));

router.post('/servers', need('servers.create'), wrap(async (req, res) => {
  const s = await apiServers.create({ user: req.user, sub: req.ctx.sub, plan: req.ctx.plan, limits: req.ctx.limits, body: req.body || {} });
  ok(res, { server: serverDto(s), message: 'Server is being created. Poll GET /servers/{id} until status is active.' }, 202);
}));

router.get('/servers/:id', need('servers.read'), wrap(async (req, res) => {
  const s = await apiServer(req);
  if (!s) return notFound(res);
  ok(res, { server: Object.assign(serverDto(s), { step: s.deploymentStatus || '', log: (s.deployLog || []).slice(-30) }) });
}));

router.get('/servers/:id/status', need('servers.status'), wrap(async (req, res) => {
  const s = await apiServer(req);
  if (!s) return notFound(res);
  if (s.status !== 'active' || !s.identifier) return ok(res, { id: String(s._id), status: s.status, state: null, message: s.deploymentStatus || '' });
  if (!ptero.clientConfigured()) return err(res, 503, 'Not configured', 'Live status is not enabled. Contact support.');
  let u; try { u = await ptero.resourceUsage(s.identifier); } catch (e) { return err(res, 502, 'Panel error', 'Could not read the server status. Try again.'); }
  ok(res, { id: String(s._id), status: s.status, state: u.state, usage: { cpuPercent: u.cpuPercent, memoryBytes: u.memoryBytes, diskBytes: u.diskBytes, networkRxBytes: u.networkRxBytes, networkTxBytes: u.networkTxBytes, uptimeMs: u.uptimeMs } });
}));

['start', 'stop', 'restart'].forEach((signal) => {
  router.post('/servers/:id/' + signal, need('servers.' + signal), wrap(async (req, res) => {
    const s = await apiServer(req);
    if (!s) return notFound(res);
    if (s.status !== 'active' || !s.identifier) return err(res, 409, 'Server not ready', 'The server is not ready yet.');
    if (!ptero.clientConfigured()) return err(res, 503, 'Not configured', 'Power control is not enabled. Contact support.');
    try { await portGuard.safePower(s, signal); } catch (e) { return err(res, 502, 'Panel error', 'The panel did not accept the command. Try again.'); }
    ok(res, { id: String(s._id), signal, message: 'Command sent.' });
  }));
});

router.delete('/servers/:id', need('servers.delete'), wrap(async (req, res) => {
  const s = await apiServer(req);
  if (!s) return notFound(res);
  await apiServers.remove(s);
  ok(res, { id: String(s._id), deleted: true });
}));

router.use((req, res) => err(res, 404, 'Not found', 'Unknown endpoint. See /api-docs.'));
router.use((e, req, res, next) => {
  if (e && e.type === 'entity.parse.failed') return err(res, 400, 'Bad JSON', 'Body must be valid JSON.');
  console.error('[api]', e && e.message); err(res, 500, 'Server error', 'Something went wrong.');
});

module.exports = router;
