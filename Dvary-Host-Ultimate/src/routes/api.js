// Public REST API  ->  /api/v1/...   (key in "Authorization: Bearer dvk_..." or "X-API-Key")
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const User = require('../models/User');
const Server = require('../models/Server');
const BotTemplate = require('../models/BotTemplate');
const Setting = require('../models/Setting');
const ptero = require('../services/pterodactylService');
const bot = require('../services/botDeploy');
const botOrder = require('../services/botOrder');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const sha = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');

const ok = (res, data, status) => res.status(status || 200).json({ ok: true, data });
const err = (res, status, code, message) => res.status(status).json({ ok: false, error: { code, message } });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error('[api]', e && e.message); err(res, 500, 'SERVER_ERROR', 'Something went wrong. Please try again.'); });

// the key is the login, so cookies are never used: allow any website/script to call the API
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 60 requests / minute / key
const hits = new Map();
function limited(id) {
  const now = Date.now(); const h = hits.get(id) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n++; hits.set(id, h);
  if (hits.size > 5000) hits.clear();
  return h.n > 60 ? Math.ceil((60000 - (now - h.t)) / 1000) : 0;
}

router.use(wrap(async (req, res, next) => {
  const m = String(req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const key = m ? m[1] : String(req.get('x-api-key') || '').trim();
  if (!/^dvk_[a-f0-9]{48}$/.test(key)) return err(res, 401, 'INVALID_KEY', 'Missing or invalid API key. Send it as: Authorization: Bearer YOUR_KEY');
  const rec = await ApiKey.findOne({ hash: sha(key), revoked: false });
  if (!rec) return err(res, 401, 'INVALID_KEY', 'This API key is invalid or was revoked.');
  const wait = limited(String(rec._id));
  if (wait) { res.setHeader('Retry-After', wait); return err(res, 429, 'RATE_LIMIT', `Too many requests. Try again in ${wait}s.`); }
  const user = await User.findById(rec.user).select('-password');
  if (!user || user.banned) return err(res, 403, 'ACCOUNT_DISABLED', 'This account is disabled.');
  const site = await Setting.getMain();
  if (site.maintenance && user.role !== 'admin') return err(res, 503, 'MAINTENANCE', 'We are under maintenance. Please try again later.');
  if (!rec.lastUsedAt || Date.now() - rec.lastUsedAt.getTime() > 60000) ApiKey.updateOne({ _id: rec._id }, { $set: { lastUsedAt: new Date(), lastIp: String(req.ip || '').slice(0, 60) }, $inc: { uses: 1 } }).catch(() => {});
  else ApiKey.updateOne({ _id: rec._id }, { $inc: { uses: 1 } }).catch(() => {});
  req.user = user; next();
}));

const maskPhone = (p) => (p && p.length > 6 ? p.slice(0, 3) + '*****' + p.slice(-2) : '');
const dep = (s) => ({ id: String(s._id), name: s.name, bot: s.templateName, status: s.status, step: s.deploymentStatus || '', pairStatus: s.pairStatus || 'none', phone: maskPhone(s.phone), createdAt: s.createdAt, expiresAt: s.expiresAt || null });
const mine = (req) => (validId(req.params.id) ? Server.findOne({ _id: req.params.id, user: req.user._id, kind: 'bot' }) : Promise.resolve(null));

router.get('/me', wrap(async (req, res) => ok(res, { id: String(req.user._id), name: req.user.name, email: req.user.email, coins: req.user.coins })));

router.get('/bots', wrap(async (req, res) => {
  const list = await BotTemplate.find({ active: true }).select('name description memory disk cpu coins days pairing').sort({ coins: 1 }).lean();
  ok(res, list.map((t) => ({ id: String(t._id), name: t.name, description: t.description, ramMB: t.memory, diskMB: t.disk, cpuPercent: t.cpu, priceCoins: t.coins, days: t.days, needsPairCode: !!t.pairing })));
}));

router.get('/deployments', wrap(async (req, res) => {
  const list = await Server.find({ user: req.user._id, kind: 'bot' }).sort({ createdAt: -1 }).limit(100).lean();
  ok(res, list.map(dep));
}));

router.post('/deployments', wrap(async (req, res) => {
  const botId = String((req.body && req.body.botId) || '');
  if (!validId(botId)) return err(res, 400, 'BAD_REQUEST', 'botId is required (get it from GET /bots).');
  try {
    const r = await botOrder.order({ user: req.user, templateId: botId, name: req.body.name });
    ok(res, Object.assign(dep(r.server), { chargedCoins: r.price }), 202);
  } catch (e) {
    if (!e.code) throw e;
    const map = { NOT_FOUND: 404, NOT_CONFIGURED: 503, BAD_NAME: 400, ALREADY_HAVE: 409, INSUFFICIENT: 402 };
    err(res, map[e.code] || 400, e.code, e.message);
  }
}));

router.get('/deployments/:id', wrap(async (req, res) => {
  const s = await mine(req);
  if (!s) return err(res, 404, 'NOT_FOUND', 'Deployment not found.');
  let power = '';
  if (s.status === 'active' && s.identifier && ptero.clientConfigured()) { try { power = await ptero.powerState(s.identifier); } catch (e) { power = ''; } }
  ok(res, Object.assign(dep(s), {
    power, pairCode: s.pairStatus === 'code_ready' ? s.pairCode : '',
    log: (s.deployLog || []).slice(-50),
    events: (s.events || []).slice(-20).reverse().map((e) => ({ at: e.at, type: e.type, text: e.text }))
  }));
}));

router.post('/deployments/:id/power', wrap(async (req, res) => {
  const s = await mine(req);
  if (!s) return err(res, 404, 'NOT_FOUND', 'Deployment not found.');
  const signal = String((req.body && req.body.signal) || '');
  if (!['start', 'stop', 'restart'].includes(signal)) return err(res, 400, 'BAD_REQUEST', 'signal must be start, stop or restart.');
  if (s.status !== 'active' || !s.identifier) return err(res, 409, 'NOT_READY', 'The bot is not ready yet.');
  if (!ptero.clientConfigured()) return err(res, 503, 'NOT_CONFIGURED', 'Console is not enabled. Contact support.');
  await ptero.power(s.identifier, signal);
  await bot.event(s._id, signal, { start: 'Bot started (API)', stop: 'Bot stopped (API)', restart: 'Bot restarted (API)' }[signal]);
  ok(res, { id: String(s._id), signal });
}));

router.post('/deployments/:id/pair', wrap(async (req, res) => {
  const s = await mine(req);
  if (!s) return err(res, 404, 'NOT_FOUND', 'Deployment not found.');
  if (s.status !== 'active') return err(res, 409, 'NOT_READY', 'The bot is not ready yet.');
  if (!ptero.clientConfigured()) return err(res, 503, 'NOT_CONFIGURED', 'Console is not enabled. Contact support.');
  const phone = String((req.body && req.body.phone) || '').replace(/[^0-9]/g, '');
  if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return err(res, 400, 'BAD_PHONE', 'phone must include the country code, digits only, e.g. 255712345678.');
  if (s.pairAt && Date.now() - s.pairAt.getTime() < 20000) return err(res, 429, 'RATE_LIMIT', 'Please wait a few seconds before asking again.');
  try { await bot.startPairing(s._id, phone); }
  catch (e) { console.error('[api pair]', e.message); await Server.updateOne({ _id: s._id }, { $set: { pairStatus: 'need_phone' } }); return err(res, 502, 'PAIR_FAILED', 'Could not start the pairing. Please try again.'); }
  ok(res, { id: String(s._id), pairStatus: 'pairing', message: 'Poll GET /deployments/{id} until pairCode is not empty.' }, 202);
}));

router.post('/deployments/:id/pair/cancel', wrap(async (req, res) => {
  const s = await mine(req);
  if (!s) return err(res, 404, 'NOT_FOUND', 'Deployment not found.');
  bot.stopWatch(s._id);
  await Server.updateOne({ _id: s._id }, { $set: { pairStatus: 'need_phone', phone: '', pairCode: '', pairAt: null } });
  ok(res, { id: String(s._id), pairStatus: 'need_phone' });
}));

router.use((req, res) => err(res, 404, 'NOT_FOUND', 'Unknown endpoint. See the docs in your dashboard.'));
router.use((e, req, res, next) => { err(res, e && e.type === 'entity.parse.failed' ? 400 : 500, e && e.type === 'entity.parse.failed' ? 'BAD_JSON' : 'SERVER_ERROR', e && e.type === 'entity.parse.failed' ? 'Body must be valid JSON.' : 'Something went wrong.'); });

router.hashKey = sha;
module.exports = router;
