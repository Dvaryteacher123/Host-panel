const express = require('express');
const mongoose = require('mongoose');
const SupportMessage = require('../models/SupportMessage');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const lastSend = new Map();
const clean = (s) => String(s || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1000);

router.get('/support', (req, res) => res.render('dashboard/support', { active: 'support' }));

// the user's own thread
router.get('/support/messages', wrap(async (req, res) => {
  const rows = await SupportMessage.find({ user: req.user._id }).sort({ createdAt: 1 }).limit(200).lean();
  await SupportMessage.updateMany({ user: req.user._id, from: 'admin', readByUser: false }, { readByUser: true });
  res.set('Cache-Control', 'no-store');
  res.json({ messages: rows.map((m) => ({ id: String(m._id), from: m.from, text: m.text, at: m.createdAt })) });
}));

router.post('/support/send', wrap(async (req, res) => {
  const text = clean(req.body.text);
  if (!text) return res.status(400).json({ ok: false, error: 'empty' });
  const uid = String(req.user._id);
  if (Date.now() - (lastSend.get(uid) || 0) < 1200) return res.status(429).json({ ok: false, error: 'slow' });
  lastSend.set(uid, Date.now());
  await SupportMessage.create({ user: req.user._id, from: 'user', text, readByUser: true });
  res.json({ ok: true });
}));

// the user can delete only his own messages
router.post('/support/:id/delete', wrap(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ ok: false });
  await SupportMessage.deleteOne({ _id: req.params.id, user: req.user._id, from: 'user' });
  res.json({ ok: true });
}));

// unread admin replies, used for the badge
router.get('/support/unread', wrap(async (req, res) => {
  const n = await SupportMessage.countDocuments({ user: req.user._id, from: 'admin', readByUser: false });
  res.json({ n });
}));

module.exports = router;
