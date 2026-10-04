const express = require('express');
const CoinOrder = require('../models/CoinOrder');
const Transaction = require('../models/Transaction');
const PaymentOrder = require('../models/PaymentOrder');
const { wrap } = require('../middleware/auth');

const router = express.Router();

router.use((req, res, next) => { if (req.path === '/coins' || req.path === '/coins/request' || req.path === '/buy') return res.redirect('/dashboard/store'); next(); });

router.get('/coins', wrap(async (req, res) => {
  const orders = await CoinOrder.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50);
  const payments = await PaymentOrder.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
  res.render('dashboard/coins', { active: 'coins', orders, payments });
}));

router.post('/coins/request', wrap(async (req, res) => {
  const coins = Number(req.body.coins);
  const note = String(req.body.note || '').trim();
  if (!Number.isInteger(coins) || coins < 1 || coins > 1000000) { req.flash('error', 'Enter a valid amount of coins.'); return res.redirect('/dashboard/coins'); }
  if (note.length < 3 || note.length > 300) { req.flash('error', 'Add a payment reference / note (3-300 characters).'); return res.redirect('/dashboard/coins'); }
  if ((await CoinOrder.countDocuments({ user: req.user._id, status: 'pending' })) >= 5) {
    req.flash('error', 'You already have 5 pending requests. Please wait for approval.');
    return res.redirect('/dashboard/coins');
  }
  await CoinOrder.create({ user: req.user._id, coins, note, status: 'pending' });
  req.flash('success', 'Request submitted. An admin will review it after verifying your payment.');
  res.redirect('/dashboard/coins');
}));

router.get('/transactions', wrap(async (req, res) => {
  const transactions = await Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200);
  res.render('dashboard/transactions', { active: 'transactions', transactions });
}));

module.exports = router;
