const express = require('express');
const mongoose = require('mongoose');
const GiftCode = require('../models/GiftCode');
const User = require('../models/User');
const wallet = require('../services/walletService');
const gifts = require('../services/giftService');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : d; };

router.get('/gifts', wrap(async (req, res) => {
  const list = await GiftCode.find().sort({ createdAt: -1 }).limit(200).lean();
  res.render('admin/gifts', { active: 'gifts', pageTitle: 'Gift coins', list, made: String(req.query.made || '') });
}));

// one code, many customers (maxUses) - or many single-use codes at once
router.post('/gifts', wrap(async (req, res) => {
  const coins = int(req.body.coins, 0), maxUses = int(req.body.maxUses, 1), count = Math.min(50, Math.max(1, int(req.body.count, 1)));
  if (coins < 1 || coins > 100000 || maxUses < 1 || maxUses > 100000) { req.flash('error', 'Coins and uses must be whole numbers of at least 1.'); return res.redirect('/admin/gifts'); }
  const days = int(req.body.days, 0);
  const custom = String(req.body.code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (custom && !/^[A-Z0-9-]{4,30}$/.test(custom)) { req.flash('error', 'Code: 4-30 letters, numbers or dashes.'); return res.redirect('/admin/gifts'); }
  const made = [];
  for (let i = 0; i < (custom ? 1 : count); i++) {
    try {
      const g = await GiftCode.create({ code: custom || gifts.makeCode(), coins, maxUses, note: String(req.body.note || '').trim().slice(0, 120), expiresAt: days > 0 ? new Date(Date.now() + days * 86400000) : null, createdBy: req.user._id });
      made.push(g.code);
    } catch (e) { if (e && e.code === 11000) { req.flash('error', 'This code already exists.'); return res.redirect('/admin/gifts'); } throw e; }
  }
  await audit(req, 'create_gift_codes', made.join(','), `${coins} coins x ${maxUses} uses`);
  req.flash('success', made.length + ' gift code(s) created.');
  res.redirect('/admin/gifts?made=' + encodeURIComponent(made.join(' ')));
}));

router.post('/gifts/:id/toggle', wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) { const g = await GiftCode.findById(req.params.id); if (g) { g.active = !g.active; await g.save(); } }
  res.redirect('/admin/gifts');
}));

router.post('/gifts/:id/delete', wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) await GiftCode.deleteOne({ _id: req.params.id });
  res.redirect('/admin/gifts');
}));

// give coins straight to one customer by email (no code needed)
router.post('/gifts/send', wrap(async (req, res) => {
  const user = await User.findOne({ email: String(req.body.email || '').trim().toLowerCase() });
  const coins = int(req.body.coins, 0);
  if (!user || coins < 1 || coins > 100000) { req.flash('error', 'Customer email not found, or coins is not a whole number of at least 1.'); return res.redirect('/admin/gifts'); }
  await wallet.creditCoins(user._id, coins, 'Gift from admin', { adminId: String(req.user._id) });
  await audit(req, 'gift_coins', user.email, coins + ' coins');
  req.flash('success', `${coins} coin(s) sent to ${user.email}.`);
  res.redirect('/admin/gifts');
}));

module.exports = router;
