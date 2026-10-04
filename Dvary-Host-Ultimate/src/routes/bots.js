const express = require('express');
const mongoose = require('mongoose');
const BotZip = require('../models/BotZip');
const BotAccess = require('../models/BotAccess');
const wallet = require('../services/walletService');
const pay = require('../services/paymentService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);
const notFound = (res) => res.status(404).render('error', { code: 404, message: 'Page not found.' });

// how to show the optional video: YouTube embed, direct video file, or a plain link
function videoInfo(url) {
  if (!url) return null;
  let u; try { u = new URL(url); } catch (e) { return null; }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{6,})/); if (m) id = m[2]; }
  }
  if (/^[\w-]{6,20}$/.test(id)) return { type: 'youtube', src: 'https://www.youtube.com/embed/' + id };
  if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(u.pathname + u.search)) return { type: 'file', src: url };
  return { type: 'link', src: url };
}

async function ownedSet(userId) {
  const rows = await BotAccess.find({ user: userId }).select('bot').lean();
  return new Set(rows.map((r) => String(r.bot)));
}
const canDownload = (req, bot, owned) => bot.type === 'free' || owned || (req.user && req.user.role === 'admin');

// ---------- list ----------
router.get('/bots', wrap(async (req, res) => {
  const t = ['free', 'vip'].includes(req.query.t) ? req.query.t : '';
  const bots = await BotZip.find(Object.assign({ active: true }, t ? { type: t } : {})).select('-link').sort({ createdAt: -1 }).lean();
  const owned = await ownedSet(req.user._id);
  res.render('dashboard/bots', { active: 'bots', bots, owned, t });
}));

// ---------- detail ----------
router.get('/bots/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const bot = await BotZip.findOne({ _id: req.params.id, active: true }).select('-link').lean();
  if (!bot) return notFound(res);
  const owned = (await ownedSet(req.user._id)).has(String(bot._id));
  res.render('dashboard/bot', { active: 'bots', bot, owned, unlocked: canDownload(req, bot, owned), video: videoInfo(bot.videoUrl) });
}));

// ---------- download (the link is only revealed here, after the checks) ----------
router.get('/bots/:id/download', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const bot = await BotZip.findOne({ _id: req.params.id, active: true });
  if (!bot) return notFound(res);
  const owned = !!(await BotAccess.exists({ user: req.user._id, bot: bot._id }));
  if (!canDownload(req, bot, owned)) { req.flash('error', 'This is a VIP bot. Unlock it first.'); return res.redirect('/dashboard/checkout/bot/' + bot._id); }
  await BotZip.updateOne({ _id: bot._id }, { $inc: { downloads: 1 } });
  res.redirect(bot.link);
}));

// ---------- unlock a VIP bot: checkout (coins or money) ----------
router.get('/checkout/bot/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const bot = await BotZip.findOne({ _id: req.params.id, active: true, type: 'vip' }).select('-link').lean();
  if (!bot) return notFound(res);
  if (await BotAccess.exists({ user: req.user._id, bot: bot._id })) return res.redirect('/dashboard/bots/' + bot._id);
  res.render('dashboard/checkout', {
    active: 'bots', mode: 'bot', title: '👑 VIP · ' + bot.title, plan: { _id: bot._id, name: bot.title }, offer: null,
    coins: bot.coins, priceTZS: bot.priceTZS || 0, prices: bot.prices || {}, needName: false, coinsEnabled: bot.coins >= 1,
    coinsAction: '/dashboard/bots/' + bot._id + '/buy', moneyAction: '/dashboard/pay/bot/' + bot._id, note: bot.description
  });
}));

router.post('/bots/:id/buy', wrap(async (req, res) => { return res.redirect('/dashboard/checkout/bot/' + req.params.id); }));

router.post('/pay/bot/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return notFound(res);
  const back = '/dashboard/checkout/bot/' + req.params.id;
  const bot = await BotZip.findOne({ _id: req.params.id, active: true, type: 'vip' }).select('-link');
  if (!bot) return notFound(res);
  if (await BotAccess.exists({ user: req.user._id, bot: bot._id })) return res.redirect('/dashboard/bots/' + bot._id);
  try {
    const order = await pay.createPayment({ user: req.user, kind: 'bot', bot, country: req.body.country, method: req.body.method, phone: req.body.phone });
    return res.redirect(order.gatewayUrl || ('/dashboard/pay/' + order._id));
  } catch (e) {
    if (e instanceof pay.PayError) { req.flash('error', e.message); return res.redirect(back); }
    throw e;
  }
}));

module.exports = router;
