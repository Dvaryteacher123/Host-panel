// "Chat with Admin" (user side). Mounted at /dashboard behind requireAuth.
// Every route checks on the SERVER that the logged-in user is a participant of the conversation.
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const svc = require('../services/chatService');
const hub = require('../services/chatHub');
const { isOnline } = require('../services/presence');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const noStore = (res) => res.set('Cache-Control', 'no-store');

router.get('/chat', (req, res) => res.render('dashboard/chat', { active: 'chat' }));

// realtime channel (Server-Sent Events) - only receives events about MY conversations
router.get('/chat/stream', (req, res) => { hub.open(req, res); hub.add(req.user._id, res); });

router.get('/chat/unread', wrap(async (req, res) => { noStore(res); res.json({ n: await svc.unreadForUser(req.user._id) }); }));

// REAL admins only (role = admin, not banned), never the person himself
router.get('/chat/admins', wrap(async (req, res) => {
  const admins = await User.find({ role: 'admin', banned: false, _id: { $ne: req.user._id } }).select('name lastSeenAt').sort({ name: 1 }).lean();
  const convs = await Conversation.find({ user: req.user._id, admin: { $in: admins.map((a) => a._id) } }).lean();
  const byAdmin = new Map(convs.map((c) => [String(c.admin), c]));
  noStore(res);
  res.json({
    admins: admins.map((a) => {
      const c = byAdmin.get(String(a._id));
      return { id: String(a._id), name: a.name, online: isOnline(a), unread: c ? c.unreadByUser : 0, last: c ? c.lastMessage : '', lastFrom: c ? c.lastSender : '', at: c ? c.lastMessageAt : null };
    }).sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name))
  });
}));

// pick an admin -> find or create the single conversation, then open the chat room
router.get('/chat/with/:adminId', wrap(async (req, res) => {
  const { adminId } = req.params;
  if (!mongoose.isValidObjectId(adminId) || String(adminId) === String(req.user._id)) return res.redirect('/dashboard/chat');
  const admin = await User.findOne({ _id: adminId, role: 'admin', banned: false }).select('name lastSeenAt');
  if (!admin) return res.status(404).render('error', { code: 404, message: 'This admin is not available.' });
  const conv = await svc.getOrCreate(req.user._id, admin._id);
  res.render('dashboard/chatroom', { active: 'chat', conv: { id: String(conv._id) }, peer: { name: admin.name, online: isOnline(admin) } });
}));

router.get('/chat/c/:cid/messages', wrap(async (req, res) => {
  const conv = await svc.loadFor(req.params.cid, req.user._id, 'user');
  if (!conv) return res.status(404).json({ ok: false });
  const admin = await User.findById(conv.admin).select('name lastSeenAt role banned').lean();
  const messages = await svc.messages(conv, 'user');
  noStore(res);
  res.json({ messages, peer: { name: admin ? admin.name : 'Admin', online: !!admin && admin.role === 'admin' && !admin.banned && isOnline(admin) } });
}));

router.post('/chat/c/:cid/send', wrap(async (req, res) => {
  const conv = await svc.loadFor(req.params.cid, req.user._id, 'user');
  if (!conv) return res.status(404).json({ ok: false });
  const r = await svc.send(conv, req.user, 'user', req.body.text);
  res.status(r.ok ? 200 : r.status).json(r);
}));

module.exports = router;
