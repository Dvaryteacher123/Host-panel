const User = require('../models/User');
const Server = require('../models/Server');
const Message = require('../models/Message');
const ptero = require('./pterodactylService');

// Deletes a customer completely: panel servers first (if one fails nothing is removed),
// then the panel account (only if this site created it), then the site records.
// Transactions and coin orders are kept for the money history.
async function deleteUserFully(target) {
  const servers = await Server.find({ user: target._id });
  if (servers.some((s) => s.pteroId) && !ptero.isConfigured()) {
    return { ok: false, error: 'Pterodactyl is not configured, so the servers cannot be removed.' };
  }
  for (const s of servers) {
    if (!s.pteroId) continue;
    try { await ptero.deleteServer(s.pteroId); } catch (e) {
      if (e.status !== 404) { console.error('user delete: server removal failed', e.message); return { ok: false, error: 'Could not delete a server on the panel. Nothing was removed. Try again.' }; }
    }
  }
  if (target.pteroManaged && target.pteroUserId && ptero.isConfigured()) {
    try { await ptero.deleteUser(target.pteroUserId); } catch (e) { if (e.status !== 404) console.error('user delete: panel account not removed', e.message); }
  }
  if (target.pteroAdmin && !target.pteroManaged && target.pteroUserId && ptero.isConfigured()) {
    try { await ptero.setRootAdmin(target.pteroUserId, false); } catch (e) { console.error('user delete: could not revoke panel admin', e.message); }
  }
  await Server.deleteMany({ user: target._id });
  await Message.deleteMany({ user: target._id });
  await User.deleteOne({ _id: target._id });
  return { ok: true, servers: servers.length };
}

module.exports = { deleteUserFully };
