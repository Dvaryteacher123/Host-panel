
const express = require('express');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const User = require('../models/User');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const lastSend = new Map();

router.get('/community', (req, res) => res.render('dashboard/community', { active: 'community' }));

router.get('/community/messages', wrap(async (req, res) => {
  const rows = await Message.find().sort({ createdAt: -1 }).limit(60).lean();
  res.set('Cache-Control', 'no-store');
  res.json({
    me: String(req.user._id), admin: req.user.role === 'admin', muted: !!req.user.muted,
    messages: rows.reverse().map((m) => ({ id: String(m._id), uid: String(m.user), name: m.name, role: m.role, text: m.text, at: m.createdAt }))
  });
}));

router.post('/community/send', wrap(async (req, res) => {
  if (req.user.muted) return res.status(403).json({ ok: false, error: 'muted' });
  const text = String(req.body.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: 'empty' });
  const uid = String(req.user._id);
  const now = Date.now();
  if (now - (lastSend.get(uid) || 0) < 1500) return res.status(429).json({ ok: false, error: 'slow' });
  lastSend.set(uid, now);
  await Message.create({ user: req.user._id, name: req.user.name, role: req.user.role, text });
  res.json({ ok: true });
}));

router.post('/community/:id/delete', wrap(async (req, res) => {
  if (req.user.role !== 'admin' || !mongoose.isValidObjectId(req.params.id)) return res.status(403).json({ ok: false });
  await Message.deleteOne({ _id: req.params.id });
  res.json({ ok: true });
}));

router.post('/community/:uid/mute', wrap(async (req, res) => {
  if (req.user.role !== 'admin' || !mongoose.isValidObjectId(req.params.uid)) return res.status(403).json({ ok: false });
  if (String(req.params.uid) === String(req.user._id)) return res.status(400).json({ ok: false });
  const u = await User.findById(req.params.uid);
  if (!u) return res.status(404).json({ ok: false });
  u.muted = !u.muted;
  await u.save();
  res.json({ ok: true, muted: u.muted });
}));

module.exports = router;
