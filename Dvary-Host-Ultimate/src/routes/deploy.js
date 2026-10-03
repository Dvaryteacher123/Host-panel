const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const BotTemplate = require('../models/BotTemplate');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const queue = require('../services/deployQueue');
const bot = require('../services/botDeploy');
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
    BotTemplate.find({ active: true }).select('-zipFile -environment -startup -codeRegex').sort({ coins: 1, createdAt: -1 }).lean(),
    Server.find({ user: req.user._id, kind: 'bot' }).select('name templateName status pairStatus phone createdAt expiresAt').sort({ createdAt: -1 }).limit(6).lean()
  ]);
  res.render('dashboard/deploy', { active: 'deploy', pageTitle: 'Deploy Bot', templates, mineList, ready: ptero.isConfigured() && ptero.clientConfigured(), maskPhone });
}));

// ---------- History: every deploy with its events ----------
router.get('/deploy/history', wrap(async (req, res) => {
  const list = await Server.find({ user: req.user._id, kind: 'bot' }).sort({ createdAt: -1 }).limit(100).lean();
  res.render('dashboard/deploy-history', { active: 'deploy', pageTitle: 'Deploy History', list, maskPhone });
}));

// ---------- Pay (coins) + deploy ----------
router.post('/deploy/new/:tid', wrap(async (req, res) => {
  if (!validId(req.params.tid)) return notFound(res);
  const back = '/dashboard/deploy';
  const tpl = await BotTemplate.findOne({ _id: req.params.tid, active: true });
  if (!tpl) { req.flash('error', 'This bot is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured() || !ptero.clientConfigured()) { req.flash('error', 'Bot hosting is not set up yet. Please contact support.'); return res.redirect(back); }
  const name = (String(req.body.name || '').trim() || tpl.name).slice(0, 60);
  if (name.length < 3) { req.flash('error', 'Name must be at least 3 characters.'); return res.redirect(back); }

  const price = tpl.coins;
  if (price < 1) {
    // free bots: one running copy per customer
    const have = await Server.countDocuments({ user: req.user._id, kind: 'bot', template: tpl._id, status: { $in: ['pending', 'active', 'suspended'] } });
    if (have >= 1) { req.flash('error', 'You already have this free bot. Delete it first to deploy again.'); return res.redirect(back); }
  } else if (req.user.coins < price) {
    req.flash('error', `You need ${price} coins to deploy this bot. Add coins first.`); return res.redirect('/dashboard/coins');
  }

  let debit = null;
  if (price >= 1) {
    try { debit = await wallet.debitCoins(req.user._id, price, 'Bot deploy', { template: String(tpl._id), templateName: tpl.name, serverName: name }); }
    catch (e) { if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect('/dashboard/coins'); } throw e; }
  }
  const server = await Server.create({
    user: req.user._id, kind: 'bot', template: tpl._id, templateName: tpl.name, planName: tpl.name, name, status: 'pending', paidCoins: price,
    expiresAt: tpl.days > 0 ? periodSvc.addDays(new Date(), tpl.days) : null, periodDays: tpl.days || 0,
    resources: { memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu, databases: tpl.databases, backups: tpl.backups },
    deploymentStatus: 'In queue…', deployLog: ['› Order received'],
    events: [{ at: new Date(), type: 'order', text: price >= 1 ? `Paid ${price} coins` : 'Free bot' }]
  });
  queue.enqueue(() => bot.deploy({ serverId: server._id, userId: req.user._id, templateId: tpl._id, name, debitReference: debit ? debit.transaction.reference : 'FREE', refundAmount: price }));
  res.redirect('/dashboard/deploy/' + server._id);
}));

// ---------- One deployment: live log, phone, pair code, start/stop ----------
router.get('/deploy/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const server = await mine(req).lean();
  if (!server) return notFound(res);
  const tpl = server.template ? await BotTemplate.findById(server.template).select('name pairing coins days iconUrl').lean() : null;
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

// pay again with coins to add time (bots with a duration)
router.post('/deploy/:id/renew', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const s = await mine(req);
  if (!s) return notFound(res);
  const back = '/dashboard/deploy/' + s._id;
  const tpl = s.template ? await BotTemplate.findById(s.template) : null;
  if (!tpl || !(tpl.days > 0) || tpl.coins < 1) { req.flash('error', 'This bot cannot be renewed.'); return res.redirect(back); }
  try { var d = await wallet.debitCoins(req.user._id, tpl.coins, 'Bot renew', { template: String(tpl._id), serverName: s.name }); }
  catch (e) { if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect('/dashboard/coins'); } throw e; }
  const ok = await expiry.extend(s._id, tpl.days, 'coin-' + d.transaction.reference);
  if (!ok) { await wallet.refundCoins(req.user._id, tpl.coins, 'Bot renew refund', { serverName: s.name }).catch(() => {}); req.flash('error', 'Could not renew. Coins refunded.'); return res.redirect(back); }
  await bot.event(s._id, 'renew', `Renewed for ${tpl.days} days (${tpl.coins} coins)`);
  req.flash('success', `Renewed for ${tpl.days} days.`);
  res.redirect(back);
}));

module.exports = router;
