const express = require('express');
const bcrypt = require('bcryptjs');
const Server = require('../models/Server');
const CoinOrder = require('../models/CoinOrder');
const Plan = require('../models/Plan');
const BotTemplate = require('../models/BotTemplate');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const github = require('../services/githubService');
const { wrap } = require('../middleware/auth');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const [servers, pendingOrders, recentTx] = await Promise.all([
    Server.find({ user: req.user._id }).sort({ createdAt: -1 }),
    CoinOrder.countDocuments({ user: req.user._id, status: 'pending' }),
    Transaction.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(5)
  ]);
  res.render('dashboard/home', {
    active: 'home', servers, pendingOrders, recentTx,
    totalServers: servers.length,
    activeServers: servers.filter((s) => s.status === 'active').length
  });
}));

router.get('/store', wrap(async (req, res) => {
  const [plans, bots] = await Promise.all([
    Plan.find({ active: true }).sort({ coins: 1 }),
    BotTemplate.find({ active: true }).sort({ name: 1 }).select('name description gitUrl imageUrl')
  ]);
  res.render('dashboard/store', {
    active: 'store', plans, bots, selected: String(req.query.plan || ''),
    githubConnected: !!req.user.githubId
  });
}));

router.get('/github/repos', wrap(async (req, res) => {
  if (!req.user.githubToken) return res.status(401).json({ ok: false, connected: false, message: 'Connect GitHub first.' });
  try {
    const token = github.decryptToken(req.user.githubToken);
    const repos = await github.getRepos(token);
    res.json({ ok: true, repos });
  } catch (e) {
    console.error('GitHub repo list failed:', e.message);
    if (e.status === 401) {
      await User.updateOne({ _id: req.user._id }, { $set: { githubToken: '', githubId: '', githubLogin: '' } });
      return res.status(401).json({ ok: false, connected: false, message: 'GitHub authorization expired. Connect GitHub again.' });
    }
    res.status(502).json({ ok: false, message: 'Could not load your GitHub repositories.' });
  }
}));

router.post('/github/disconnect', wrap(async (req, res) => {
  await User.updateOne({ _id: req.user._id }, { $set: { githubId: '', githubLogin: '', githubToken: '' } });
  req.flash('success', 'GitHub disconnected.');
  res.redirect('/dashboard/store');
}));

router.get('/profile', wrap(async (req, res) => {
  const [spent, servers] = await Promise.all([
    Transaction.aggregate([{ $match: { user: req.user._id, type: 'debit' } }, { $group: { _id: null, sum: { $sum: '$amount' } } }]),
    Server.countDocuments({ user: req.user._id })
  ]);
  res.render('dashboard/profile', { active: 'profile', totalSpent: spent[0] ? spent[0].sum : 0, serverTotal: servers });
}));

router.post('/profile/password', wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const user = await User.findById(req.user._id);
  if (!(await bcrypt.compare(current, user.password))) { req.flash('error', 'Current password is incorrect.'); return res.redirect('/dashboard/profile'); }
  if (next.length < 8 || next.length > 100) { req.flash('error', 'New password must be at least 8 characters.'); return res.redirect('/dashboard/profile'); }
  if (next !== confirm) { req.flash('error', 'Passwords do not match.'); return res.redirect('/dashboard/profile'); }
  user.password = await bcrypt.hash(next, 12);
  await user.save();
  req.flash('success', 'Password changed.');
  res.redirect('/dashboard/profile');
}));

module.exports = router;
