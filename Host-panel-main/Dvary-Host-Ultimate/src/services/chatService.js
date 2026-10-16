const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const ChatMessage = require('../models/ChatMessage');
const User = require('../models/User');
const hub = require('./chatHub');

const clean = (s) => String(s || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000);
const lastSend = new Map();

// find-or-create the ONE conversation between this user and this admin (no duplicates)
exports.getOrCreate = async (userId, adminId) => {
  try {
    return await Conversation.findOneAndUpdate(
      { user: userId, admin: adminId },
      { $setOnInsert: { user: userId, admin: adminId } },
      { new: true, upsert: true }
    );
  } catch (e) {
    if (e.code === 11000) return Conversation.findOne({ user: userId, admin: adminId }); // lost a race, the other request created it
    throw e;
  }
};

// load a conversation ONLY if `me` is one of its two participants (otherwise null -> 404)
exports.loadFor = async (cid, me, side) => {
  if (!mongoose.isValidObjectId(cid)) return null;
  return Conversation.findOne({ _id: cid, [side]: me });
};

exports.messages = async (conv, side) => {
  const other = side === 'user' ? 'admin' : 'user';
  const rows = await ChatMessage.find({ conversation: conv._id }).sort({ createdAt: -1 }).limit(300).lean();
  rows.reverse();
  // opening the conversation = the viewer has read the other side's messages
  await ChatMessage.updateMany({ conversation: conv._id, senderRole: other, read: false }, { $set: { read: true } });
  const left = await ChatMessage.countDocuments({ conversation: conv._id, senderRole: other, read: false });
  const field = side === 'user' ? 'unreadByUser' : 'unreadByAdmin';
  if (conv[field] !== left) await Conversation.updateOne({ _id: conv._id }, { $set: { [field]: left } });
  if (rows.some((m) => m.senderRole === other && !m.read)) hub.push(side === 'user' ? conv.admin : conv.user, { t: 'read', c: String(conv._id) });
  return rows.map((m) => ({ id: String(m._id), from: m.senderRole, text: m.text, at: m.createdAt, read: m.read || m.senderRole === other }));
};

// returns {ok:true} or {ok:false,status,error}
exports.send = async (conv, senderUser, side, rawText) => {
  const text = clean(rawText);
  if (!text) return { ok: false, status: 400, error: 'empty' };
  const key = String(senderUser._id);
  if (Date.now() - (lastSend.get(key) || 0) < 800) return { ok: false, status: 429, error: 'slow' };
  lastSend.set(key, Date.now());
  // the admin of this conversation must still be a real, active admin
  const adminDoc = await User.findOne({ _id: conv.admin, role: 'admin', banned: false }).select('_id');
  if (!adminDoc) return { ok: false, status: 410, error: 'gone' };

  const msg = await ChatMessage.create({ conversation: conv._id, sender: senderUser._id, senderRole: side, text });
  await Conversation.updateOne({ _id: conv._id }, {
    $set: { lastMessage: text.slice(0, 120), lastMessageAt: msg.createdAt, lastSender: side },
    $inc: side === 'user' ? { unreadByAdmin: 1 } : { unreadByUser: 1 }
  });
  const ev = { t: 'm', c: String(conv._id) };
  hub.push(conv.user, ev);
  hub.push(conv.admin, ev);
  return { ok: true };
};

exports.unreadForUser = async (uid) => {
  const r = await Conversation.aggregate([{ $match: { user: new mongoose.Types.ObjectId(String(uid)) } }, { $group: { _id: null, n: { $sum: '$unreadByUser' } } }]);
  return r[0] ? r[0].n : 0;
};
exports.unreadForAdmin = async (uid) => {
  const r = await Conversation.aggregate([{ $match: { admin: new mongoose.Types.ObjectId(String(uid)) } }, { $group: { _id: null, n: { $sum: '$unreadByAdmin' } } }]);
  return r[0] ? r[0].n : 0;
};
