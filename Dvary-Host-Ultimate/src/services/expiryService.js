// Servers that have a duration: free ones delete themselves; paid ones are suspended when the time is over,
// and deleted if the customer does not renew within the grace period.
const Server = require('../models/Server');
const ptero = require('./pterodactylService');

const graceDays = () => { const n = Number(process.env.EXPIRE_GRACE_DAYS); return n >= 0 && Number.isFinite(n) ? n : 3; };
exports.graceDays = graceDays;

async function removeFromPanel(s) {
  if (s.pteroId && ptero.isConfigured()) {
    try { await ptero.deleteServer(s.pteroId); } catch (e) { if (e.status !== 404) throw e; }
  }
}

exports.run = async () => {
  try {
    const now = new Date();
    // 1) time is over
    const due = await Server.find({ status: 'active', expiresAt: { $ne: null, $lte: now } }).limit(50);
    for (const s of due) {
      try {
        if (s.isFree) {
          await removeFromPanel(s);
          await Server.deleteOne({ _id: s._id });
          console.log('[expiry] free server deleted:', s.name);
        } else {
          if (s.pteroId && ptero.isConfigured()) await ptero.suspendServer(s.pteroId);
          await Server.updateOne({ _id: s._id, status: 'active' }, { $set: { status: 'suspended', suspendReason: 'expired', expiredAt: now } });
          console.log('[expiry] server suspended (expired):', s.name);
        }
      } catch (e) { console.error('[expiry] failed for', s.name, e.message); }
    }
    // 2) grace period over: delete
    const cutoff = new Date(now.getTime() - graceDays() * 86400000);
    const dead = await Server.find({ status: 'suspended', suspendReason: 'expired', expiredAt: { $lte: cutoff } }).limit(50);
    for (const s of dead) {
      try { await removeFromPanel(s); await Server.deleteOne({ _id: s._id }); console.log('[expiry] expired server deleted:', s.name); }
      catch (e) { console.error('[expiry] delete failed for', s.name, e.message); }
    }
  } catch (e) { console.error('[expiry] run failed', e.message); }
};

// add days to a server (renewal). Safe to call twice with the same orderId: the second call does nothing.
exports.extend = async (serverId, days, orderId) => {
  const s = await Server.findById(serverId);
  if (!s) return false;
  const now = new Date();
  const base = s.expiresAt && s.expiresAt > now ? s.expiresAt : now;
  const expiresAt = new Date(base.getTime() + days * 86400000);
  const cond = { _id: s._id };
  const update = { $set: { expiresAt, isFree: false, periodDays: days } };
  if (orderId) { cond.renewedBy = { $ne: orderId }; update.$addToSet = { renewedBy: orderId }; }
  const done = await Server.findOneAndUpdate(cond, update);
  if (!done) return false;
  if (s.status === 'suspended' && s.suspendReason === 'expired') {
    if (s.pteroId && ptero.isConfigured()) await ptero.unsuspendServer(s.pteroId);
    await Server.updateOne({ _id: s._id }, { $set: { status: 'active', suspendReason: '', expiredAt: null } });
  }
  return true;
};
