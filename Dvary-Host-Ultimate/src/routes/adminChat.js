// "Customer Chats" (admin side). Mounted at /admin behind requireAdmin.
// An admin only ever sees conversations where conversation.admin === his own id.
const express = require('express');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const svc = require('../services/chatService');
const hub = require('../services/chatHub');
const presence = require('../services/presence');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const noStore = (res) => res.set('Cache-Control', 'no-store');

router.get('/chats', (req, res) => res.render('admin/chats', { active: 'chats' }));

router.get('/chats/stream', (req, res) => { hub.open(req, res); hub.add(req.user._id, res); });

// heartbeat -> admin shows as Online to users
router.post('/presence', wrap(async (req, res) => { await presence.touch(req.user._id, true); res.json({ ok: true }); }));

router.get('/chats/unread', wrap(async (req, res) => { noStore(res); res.json({ n: await svc.unreadForAdmin(req.user._id) }); }));

router.get('/chats/list', wrap(async (req, res) => {
  const convs = await Conversation.find({ admin: req.user._id }).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(200).lean();
  const users = await User.find({ _id: { $in: convs.map((c) => c.user) } }).select('name email').lean();
  const map = new Map(users.map((u) => [String(u._id), u]));
  noStore(res);
  res.json({
    total: convs.reduce((n, c) => n + (c.unreadByAdmin || 0), 0),
    chats: convs.map((c) => { const u = map.get(String(c.user)) || {}; return { cid: String(c._id), name: u.name || 'Deleted user', email: u.email || '', last: c.lastMessage, lastFrom: c.lastSender, at: c.lastMessageAt || c.createdAt, unread: c.unreadByAdmin || 0 }; })
  });
}));

router.get('/chats/:cid/messages', wrap(async (req, res) => {
  const conv = await svc.loadFor(req.params.cid, req.user._id, 'admin');
  if (!conv) return res.status(404).json({ ok: false });
  noStore(res);
  res.json({ messages: await svc.messages(conv, 'admin') });
}));

router.post('/chats/:cid/send', wrap(async (req, res) => {
  const conv = await svc.loadFor(req.params.cid, req.user._id, 'admin');
  if (!conv) return res.status(404).json({ ok: false });
  const r = await svc.send(conv, req.user, 'admin', req.body.text);
  res.status(r.ok ? 200 : r.status).json(r);
}));

module.exports = router;
