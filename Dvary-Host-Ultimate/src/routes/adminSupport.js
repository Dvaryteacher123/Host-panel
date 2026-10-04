const express = require('express');
const mongoose = require('mongoose');
const SupportMessage = require('../models/SupportMessage');
const User = require('../models/User');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const clean = (s) => String(s || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1000);

router.get('/support', (req, res) => res.render('admin/support', { active: 'support' }));

// list of conversations, newest first, with unread counts
router.get('/support/threads', wrap(async (req, res) => {
  const agg = await SupportMessage.aggregate([
    { $sort: { createdAt: -1 } },
    { $group: { _id: '$user', last: { $first: '$text' }, lastFrom: { $first: '$from' }, at: { $first: '$createdAt' },
        unread: { $sum: { $cond: [{ $and: [{ $eq: ['$from', 'user'] }, { $eq: ['$readByAdmin', false] }] }, 1, 0] } } } },
    { $sort: { at: -1 } }, { $limit: 100 }
  ]);
  const users = await User.find({ _id: { $in: agg.map((a) => a._id) } }).select('name email').lean();
  const map = new Map(users.map((u) => [String(u._id), u]));
  res.set('Cache-Control', 'no-store');
  res.json({ threads: agg.map((a) => { const u = map.get(String(a._id)) || {}; return { uid: String(a._id), name: u.name || 'Deleted user', email: u.email || '', last: a.last, lastFrom: a.lastFrom, at: a.at, unread: a.unread }; }) });
}));

router.get('/support/:uid/messages', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.uid)) return res.status(400).json({ ok: false });
  const rows = await SupportMessage.find({ user: req.params.uid }).sort({ createdAt: 1 }).limit(300).lean();
  await SupportMessage.updateMany({ user: req.params.uid, from: 'user', readByAdmin: false }, { readByAdmin: true });
  res.set('Cache-Control', 'no-store');
  res.json({ messages: rows.map((m) => ({ id: String(m._id), from: m.from, text: m.text, at: m.createdAt })) });
}));

router.post('/support/:uid/send', wrap(async (req, res) => {
  const text = clean(req.body.text);
  if (!text || !mongoose.isValidObjectId(req.params.uid)) return res.status(400).json({ ok: false });
  await SupportMessage.create({ user: req.params.uid, from: 'admin', text, readByAdmin: true });
  res.json({ ok: true });
}));

// admin can delete any single message
router.post('/support/msg/:id/delete', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false });
  await SupportMessage.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

// admin can clear a whole conversation
router.post('/support/:uid/clear', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.uid)) return res.status(400).json({ ok: false });
  await SupportMessage.deleteMany({ user: req.params.uid });
  res.json({ ok: true });
}));

module.exports = router;
