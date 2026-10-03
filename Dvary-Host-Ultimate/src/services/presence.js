const User = require('../models/User');

// An admin counts as Online when the browser sent a heartbeat within this window.
const ONLINE_MS = Number(process.env.ADMIN_ONLINE_SECONDS || 60) * 1000;
const lastTouch = new Map();

exports.ONLINE_MS = ONLINE_MS;
exports.isOnline = (u) => !!(u && u.lastSeenAt && Date.now() - new Date(u.lastSeenAt).getTime() < ONLINE_MS);

// save "last seen" (throttled so we do not hit the database on every request)
exports.touch = async (userId, force) => {
  const id = String(userId);
  if (!force && Date.now() - (lastTouch.get(id) || 0) < 15000) return;
  lastTouch.set(id, Date.now());
  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: new Date() } });
};

exports.clear = async (userId) => {
  lastTouch.delete(String(userId));
  await User.updateOne({ _id: userId }, { $set: { lastSeenAt: null } });
};
