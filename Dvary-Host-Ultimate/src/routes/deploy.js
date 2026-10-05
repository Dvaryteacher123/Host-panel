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
const Offer = require('../models/Offer');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });
const mine = (req) => Server.findOne({ _id: req.params.id, user: req.user._id, kind: 'bot' });
const maskPhone = (p) => (p && p.length > 6 ? '+' + p.slice(0, 3) + '•••••' + p.slice(-2) : (p ? '+' + p : ''));

// ---------- Deploy home: the bots the admin prepared ----------
router.get('/deploy', wrap(async (req, res) => {
  const [templates, mineList, privateOffers] = await Promise.all([
    BotTemplate.find({ active: true }).select('-zipFile -environment -startup -codeRegex').sort({ coins: 1, createdAt: -1 }).lean(),
    Server.find({ user: req.user._id, kind: 'bot' }).select('name templateName status pairStatus phone createdAt expiresAt').sort({ createdAt: -1 }).limit(6).lean(),
    Offer.find({
      user: req.user._id,
      status: 'active',
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
    }).select('_id botTemplate coins note expiresAt').lean()
  ]);
  const offerMap = new Map(privateOffers.filter(o => o.botTemplate).map(o => [String(o.botTemplate), o]));
  templates.forEach(t => { t.privateOffer = offerMap.get(String(t._id)) || null; });
  res.render('dashboard/deploy', { active: 'deploy', pageTitle: 'Deploy Bot', templates, mineList, ready: ptero.isConfigured() && ptero.clientConfigured(), maskPhone });
}));

// ---------- History: every deploy with its events ----------
router.get('/deploy/history', wrap(async (req, res) => {
  const list = await Server.find({ user: req.user._id, kind: 'bot' }).sort({ createdAt: -1 }).limit(100).lean();
  res.render('dashboard/deploy-history', { active: 'deploy', pageTitle: 'Deploy History', list, maskPhone });
}));

// ---------- Pay (coins) + deploy ----------
async function renderBotCheckout(req, res, tpl, prefillName) {
  const privateOffer = await Offer.findOne({
    user: req.user._id,
    botTemplate: tpl._id,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).lean();
  const coinOffer = privateOffer ? { _id: privateOffer._id, coins: privateOffer.coins, note: privateOffer.note || 'Private coin offer from admin.' } : null;
  return res.render('dashboard/checkout', {
    active: 'deploy', mode: 'botdeploy', title: '🚀 Deploy · ' + tpl.name,
    plan: { _id: tpl._id, name: tpl.name, memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu }, offer: coinOffer,
    coins: coinOffer ? coinOffer.coins : 0, priceTZS: tpl.priceTZS || 0, prices: tpl.prices || {}, needName: true,
    prefillName: String(prefillName || '').trim(),
    moneyAction: '/dashboard/pay/deploy/' + tpl._id,
    coinOfferAction: coinOffer ? '/dashboard/deploy/coin/' + tpl._id : '',
    note: tpl.description || 'Enter your server name, choose your country, pay, and the bot will deploy automatically.'
  });
}

// ---------- Private coin offer for a specific customer + bot ----------
router.post('/deploy/coin/:tid', wrap(async (req, res) => {
  if (!validId(req.params.tid)) return notFound(res);
  const name = String(req.body.name || '').trim();
  const back = '/dashboard/checkout/deploy/' + req.params.tid;
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  if (!ptero.isConfigured() || !ptero.clientConfigured()) { req.flash('error', 'Bot hosting is not configured yet.'); return res.redirect(back); }

  const requestedCoins = Number(req.body.coinAmount || 0);
  const offer = await Offer.findOneAndUpdate({
    _id: req.body.offerId || undefined,
    user: req.user._id,
    botTemplate: req.params.tid,
    status: 'active',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }, { $set: { status: 'used', usedAt: new Date(), usedWith: 'coins' } }, { new: true });
  if (!offer) { req.flash('error', 'You do not have an active coin offer for this bot.'); return res.redirect(back); }
  if (requestedCoins !== Number(offer.coins)) {
    await Offer.updateOne({ _id: offer._id, status: 'used' }, { $set: { status: 'active', usedAt: null, usedWith: '', server: null } });
    req.flash('error', 'Coin amount does not match your private offer.');
    return res.redirect(back);
  }

  let debit = null;
  try {
    if (offer.coins > 0) debit = await wallet.debitCoins(req.user._id, offer.coins, 'Bot private offer', { offer: String(offer._id), botTemplate: req.params.tid, serverName: name });
    const tpl = await BotTemplate.findOne({ _id: req.params.tid, active: true }).lean();
    if (!tpl) throw new Error('Bot template is no longer available.');
    const server = await Server.create({
      user: req.user._id, kind: 'bot', template: tpl._id, templateName: tpl.name, name,
      status: 'pending', paidCoins: offer.coins,
      expiresAt: offer.serverDays > 0 ? periodSvc.addDays(new Date(), offer.serverDays) : null,
      periodDays: offer.serverDays || 0,
      resources: { memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu, databases: tpl.databases, backups: tpl.backups },
      deploymentStatus: 'In queue…'
    });
    await Offer.updateOne({ _id: offer._id }, { $set: { server: server._id } });
    queue.enqueue(() => bot.deploy({ serverId: server._id, userId: req.user._id, templateId: tpl._id, name, debitReference: debit ? debit.transaction.reference : 'PRIVATE-OFFER-FREE', refundAmount: offer.coins }));
    req.flash('success', 'Offer accepted! Your bot is being deployed…');
    return res.redirect('/dashboard/deploy/' + server._id);
  } catch (e) {
    await Offer.updateOne({ _id: offer._id, status: 'used' }, { $set: { status: 'active', usedAt: null, usedWith: '', server: null } }).catch(() => {});
    if (debit && offer.coins > 0) await wallet.refundCoins(req.user._id, offer.coins, 'Private offer refund', { offer: String(offer._id), serverName: name }).catch(() => {});
    if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins for your private offer.'); return res.redirect(back); }
    throw e;
  }
}));

// ---------- Start deployment: collect the server name, then show the payment checkout immediately ----------
router.post('/deploy/new/:tid', wrap(async (req, res) => {
  if (!validId(req.params.tid)) return notFound(res);
  const tpl = await BotTemplate.findOne({ _id: req.params.tid, active: true }).lean();
  if (!tpl) return notFound(res);
  const name = String(req.body.name || '').trim();
  if (name.length < 3 || name.length > 60) {
    req.flash('error', 'Server name must be 3-60 characters.');
    return res.redirect('/dashboard/deploy');
  }
  return renderBotCheckout(req, res, tpl, name);
}));

// ---------- Money checkout for bot deployment ----------
router.get('/checkout/deploy/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const tpl = await BotTemplate.findOne({ _id: req.params.id, active: true }).lean();
  if (!tpl) return notFound(res);
  return renderBotCheckout(req, res, tpl, req.query.name || '');
}));

router.post('/pay/deploy/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const back = '/dashboard/checkout/deploy/' + req.params.id;
  const name = String(req.body.name || '').trim();
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  const tpl = await BotTemplate.findOne({ _id: req.params.id, active: true });
  if (!tpl) return notFound(res);
  if (!ptero.isConfigured() || !ptero.clientConfigured()) { req.flash('error', 'Bot hosting is not configured yet.'); return res.redirect(back); }
  try {
    const order = await require('../services/paymentService').createPayment({ user: req.user, kind: 'botdeploy', botTemplate: tpl, serverName: name, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    const pay = require('../services/paymentService');
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
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
  const cmd = String(req.body.command || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  if (!s || s.status !== 'active' || !s.identifier || !cmd || !ptero.clientConfigured()) return res.status(400).json({ ok: false });
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
