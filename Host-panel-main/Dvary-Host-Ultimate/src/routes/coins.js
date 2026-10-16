const express = require('express');
const CoinOrder = require('../models/CoinOrder');
const Transaction = require('../models/Transaction');
const PaymentOrder = require('../models/PaymentOrder');
const { wrap } = require('../middleware/auth');

const router = express.Router();

// the coin shop and manual coin requests were removed. Coins now exist only as offers given by the admin.
router.get('/coins', (req, res) => res.redirect('/dashboard/payments'));
router.post('/coins/request', (req, res) => { req.flash('error', 'Coins can no longer be bought. Pay for what you need with money.'); res.redirect('/dashboard/store'); });

router.get('/payments', wrap(async (req, res) => {
  const payments = await PaymentOrder.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(60).lean();
  res.render('dashboard/payments', { active: 'payments', pageTitle: 'My payments', payments });
}));

router.get('/transactions', wrap(async (req, res) => {
  const transactions = await Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200);
  res.render('dashboard/transactions', { active: 'transactions', transactions });
}));

module.exports = router;
