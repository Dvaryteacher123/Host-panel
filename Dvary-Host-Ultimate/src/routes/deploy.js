const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const BotTemplate = require('../models/BotTemplate');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const queue = require('../services/deployQueue');
const bot = require('../services/botDeploy');
const botOrder = require('../services/botOrder');
const pay = require('../services/paymentService');
const expiry = require('../services/expiryService');
const periodSvc = require('../services/periodService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });
const mine = (req) => Server.findOne({ _id: req.params.id, user: req.user._id, kind: 'bot' });
const maskPhone = (p) => (p && p.length > 6 ? '+' + p.slice(0, 3) + '•••••' + p.slice(-2) : (p ? '+' + p : ''));

// ---------- Deploy home: the bots the admin prepared ----------
router.get('/deploy', wrap(async (req, res) => {
  const [templates, mineList] = await Promise.all([
    BotTemplate.find({ active: true }).select('-zipFile -environment -startup -codeRegex').sort({ free: -1, priceTZS: 1, createdAt: -1 }).lean(),
    Server.find({ user: req.user._id, kind: 'bot' }).select('name templateName status pairStatus phone createdAt expiresAt').sort({ createdAt: -1 }).limit(6).lean()
  ]);
  res.render('dashboard/deploy', { active: 'deploy', pageTitle: 'Deploy Bot', templates, mineList, ready: ptero.isConfigured() && ptero.clientConfigured(), maskPhone, defCountry: String(req.query.country || '').toUpperCase().slice(0, 2) });
}));

// ---------- History: every deploy with its events ----------
router.get('/deploy/history', wrap(async (req, res) => {
  const list = await Server.find({ user: req.user._id, kind: 'bot' }).sort({ createdAt: -1 }).limit(100).lean();
  res.render('dashboard/deploy-history', { active: 'deploy', pageTitle: 'Deploy History', list, maskPhone });
}));

// ---------- gift code -> coins ----------
router.post('/deploy/gift', wrap(async (req, res) => {
  try {
    const g = await require('../services/giftService').redeem(req.user._id, req.body.code);
    req.flash('success', `🎁 ${g.coins} coin${g.coins > 1 ? 's' : ''} added! Now press USE COIN on the bot you want.`);
  } catch (e) {
    if (e.code === 'BAD_CODE') req.flash('error', e.message); else throw e;
  }
  res.redirect('/dashboard/deploy#coins');
}));

// ---------- Free bot, or OFFER coins (only customers who were given coins by the admin) ----------
router.post('/deploy/new/:tid', wrap(async (req, res) => {
  if (!validId(req.params.tid)) return notFound(res);
  try {
    const r = await botOrder.order({ user: req.user, templateId: req.params.tid, name: req.body.name, via: req.body.via === 'coins' ? 'coins' : '' });
    return res.redirect('/dashboard/deploy/' + r.server._id);
  } catch (e) {
    if (!e.code) throw e;
    req.flash('error', e.message); return res.redirect('/dashboard/deploy');
  }
}));

// ---------- Pay with MONEY (FimiPay). The bot is installed only after the payment is confirmed. ----------
router.post('/deploy/pay/:tid', wrap(async (req, res) => {
  if (!validId(req.params.tid)) return notFound(res);
  const back = '/dashboard/deploy';
  const tpl = await BotTemplate.findOne({ _id: req.params.tid, active: true });
  if (!tpl || tpl.free) { req.flash('error', 'This bot is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured() || !ptero.clientConfigured()) { req.flash('error', 'Bot hosting is not set up yet. Please contact support.'); return res.redirect(back); }
  const name = (String(req.body.name || '').trim() || tpl.name).slice(0, 60);
  if (name.length < 3) { req.flash('error', 'Name must be at least 3 characters.'); return res.redirect(back); }
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'botdeploy', template: tpl, serverName: name, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
}));

// paid, but the install failed: try again (max 3 times, free)
router.post('/deploy/:id/retry', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const s = await mine(req);
  if (!s) return notFound(res);
  try { await botOrder.retry(s); req.flash('success', 'Trying again…'); }
  catch (e) { if (!e.code) throw e; req.flash('error', e.message); }
  res.redirect('/dashboard/deploy/' + s._id);
}));

// ---------- One deployment: live log, phone, pair code, start/stop ----------
router.get('/deploy/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const server = await mine(req).lean();
  if (!server) return notFound(res);
  const tpl = server.template ? await BotTemplate.findById(server.template).select('name pairing days iconUrl free priceTZS prices').lean() : null;
  res.render('dashboard/deploy-view', { active: 'deploy', pageTitle: server.name, server, tpl, maskPhone, consoleReady: ptero.clientConfigured() });
}));

const stateCache = new Map();
async function powerOf(server) {
  if (server.status !== 'active' || !server.identifier || !ptero.clientConfigured()) return '';
  const k = String(server._id); const c = stateCache.get(k);
  if (c && Date.now() - c.at < 4000) return c.v;
  let v = ''; try { v = await ptero.powerState(server.identifier); } catch (e) { v = ''; }
  stateCache.set(k, { at: Date.now(), v });
  if (stateCache.size > 500) stateCache.clear();
  return v;
}

router.get('/deploy/:id/status', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req).lean();
  if (!s) return res.status(404).json({ ok: false });
  res.json({
    ok: true, status: s.status, step: s.deploymentStatus, log: s.deployLog || [], pair: s.pairStatus, code: s.pairCode,
    phone: maskPhone(s.phone), power: await powerOf(s), events: (s.events || []).slice(-30).reverse().map((e) => ({ at: e.at, type: e.type, text: e.text })),
    expiresAt: s.expiresAt
  });
}));

// phone number -> pair code
router.post('/deploy/:id/phone', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req);
  if (!s || s.status !== 'active') return res.status(400).json({ ok: false, error: 'Your bot is not ready yet.' });
  if (!ptero.clientConfigured()) return res.status(400).json({ ok: false, error: 'Console is not enabled. Contact support.' });
  const phone = String(req.body.phone || '').replace(/[^0-9]/g, '');
  if (phone.length < 9 || phone.length > 15 || phone.startsWith('0')) return res.status(400).json({ ok: false, error: 'Enter the number with country code, e.g. 255712345678 (no + and no leading 0).' });
  if (s.pairAt && Date.now() - s.pairAt.getTime() < 20000) return res.status(429).json({ ok: false, error: 'Please wait a few seconds before asking again.' });
  try { await bot.startPairing(s._id, phone); res.json({ ok: true }); }
  catch (e) { console.error('[pair] failed', e.message); await Server.updateOne({ _id: s._id }, { $set: { pairStatus: 'need_phone' } }); res.status(502).json({ ok: false, error: 'Could not start the pairing. Please try again.' }); }
}));

// cancel / change the number: stops waiting for a code and clears the saved number
router.post('/deploy/:id/phone/reset', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req);
  if (!s) return res.status(404).json({ ok: false });
  bot.stopWatch(s._id);
  await Server.updateOne({ _id: s._id }, { $set: { pairStatus: 'need_phone', phone: '', pairCode: '', pairAt: null } });
  await bot.event(s._id, 'pair', 'Number removed - you can enter a new one');
  res.json({ ok: true });
}));

// skip the number form: the customer types it himself in the console (or links later)
router.post('/deploy/:id/skip', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req);
  if (!s || s.status !== 'active') return res.status(400).json({ ok: false });
  bot.stopWatch(s._id);
  await Server.updateOne({ _id: s._id }, { $set: { pairStatus: 'none', phone: '', pairCode: '' } });
  try { if (ptero.clientConfigured() && s.identifier && (await ptero.powerState(s.identifier)) === 'offline') await ptero.power(s.identifier, 'start'); } catch (e) { /* user can press START */ }
  await bot.event(s._id, 'pair', 'Number form skipped - using the console');
  res.json({ ok: true });
}));

// type a line into the bot console (answer the bot's own questions yourself)
const lastCmd = new Map();
router.post('/deploy/:id/command', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req);
  const cmd = String(req.body.command || '').replace(/[\r\n]+/g, ' ').slice(0, 300);     // ANY text: numbers, words, 02, y/n ... (an empty line = the Enter key)
  if (!s || s.status !== 'active' || !s.identifier || !ptero.clientConfigured()) return res.status(400).json({ ok: false });
  const k = String(s._id); if (Date.now() - (lastCmd.get(k) || 0) < 700) return res.status(429).json({ ok: false });
  lastCmd.set(k, Date.now()); if (lastCmd.size > 1000) lastCmd.clear();
  try { await ptero.sendCommand(s.identifier, cmd); res.json({ ok: true }); } catch (e) { console.error('[deploy command]', e.message); res.status(502).json({ ok: false }); }
}));

// start / stop / restart (any time, also later)
router.post('/deploy/:id/power', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).json({ ok: false });
  const s = await mine(req);
  const signal = String(req.body.signal || '');
  if (!s || !['start', 'stop', 'restart'].includes(signal) || s.status !== 'active' || !s.identifier || !ptero.clientConfigured()) return res.status(400).json({ ok: false });
  try {
    await ptero.power(s.identifier, signal);
    stateCache.delete(String(s._id));
    await bot.event(s._id, signal, { start: 'Bot started', stop: 'Bot stopped', restart: 'Bot restarted' }[signal]);
    res.json({ ok: true });
  } catch (e) { console.error('[deploy power]', e.message); res.status(502).json({ ok: false }); }
}));

// pay again (money) to add time to a bot that has a duration
router.post('/deploy/:id/renew', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const s = await mine(req);
  if (!s) return notFound(res);
  const back = '/dashboard/deploy/' + s._id;
  const tpl = s.template ? await BotTemplate.findById(s.template) : null;
  if (!tpl || !(tpl.days > 0) || tpl.free) { req.flash('error', 'This bot cannot be renewed.'); return res.redirect(back); }
  const period = { index: -1, days: tpl.days, label: tpl.days + ' days', priceTZS: tpl.priceTZS, prices: tpl.prices || {} };
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'renew', server: s, period, serverName: s.name, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
}));

module.exports = router;
