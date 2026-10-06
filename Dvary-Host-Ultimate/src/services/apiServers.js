// Server creation / deletion for API customers. Talks to Pterodactyl with the site's OWN credentials
// (the customer never gets a Pterodactyl key). Limits come from the database (ApiPlan + per-customer overrides).
const Server = require('../models/Server');
const User = require('../models/User');
const ApiSubscription = require('../models/ApiSubscription');
const ptero = require('./pterodactylService');
const queue = require('./deployQueue');
const subSvc = require('./apiSubscription');

const fail = (code, message, status) => Object.assign(new Error(message), { code, status: status || 400 });
exports.fail = fail;

const intIn = (v, d) => { if (v === undefined || v === null || v === '') return d; const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : NaN; };

function eggAllowed(plan, nestId, eggId) {
  const lines = String(plan.allowedEggs || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return true;
  return lines.some((l) => { const m = l.match(/^(\d+)\s*:\s*(\d+)$/); return m && Number(m[1]) === nestId && Number(m[2]) === eggId; });
}

async function provision({ serverId, userId, name, nestId, eggId, res }) {
  let pteroId = null;
  try {
    const user = await User.findById(userId);
    if (!user) throw new Error('user missing');
    const acct = await ptero.ensureUser(user);
    if (acct.created) await User.updateOne({ _id: userId }, { $set: { pteroManaged: true } });
    const created = await ptero.createServer({
      pteroUserId: acct.id, name, externalId: serverId,
      plan: { memory: res.memory, disk: res.disk, cpu: res.cpu, databases: 0, backups: 0, nestId: nestId || undefined, eggId: eggId || undefined }
    });
    pteroId = created.id;
    await Server.updateOne({ _id: serverId }, { $set: { pteroId: created.id, identifier: created.identifier, port: created.port || null, panelPassword: acct.generatedPassword || '', status: 'active', deploymentStatus: 'Server created. It is installing on the panel.' }, $push: { deployLog: '✅ Server created' } });
  } catch (e) {
    console.error('[api server] provision failed', String(serverId), e && e.message);
    await Server.updateOne({ _id: serverId, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: 'Could not create the server. Please try again.' } });
    if (pteroId) { try { await ptero.deleteServer(pteroId); } catch (x) { /* the admin can clean up on the panel */ } }
  }
}

// body: { name, memory, disk, cpu, nestId?, eggId? } - everything is checked against the customer's limits
exports.create = async ({ user, sub, plan, limits, body }) => {
  if (!ptero.isConfigured()) throw fail('NOT_CONFIGURED', 'Server hosting is not configured yet. Please contact support.', 503);
  const name = String((body && body.name) || '').trim();
  if (name.length < 3 || name.length > 60) throw fail('BAD_NAME', 'name must be 3-60 characters.');

  const memory = intIn(body.memory, Math.min(512, limits.maxRamMB));
  const disk = intIn(body.disk, Math.min(1024, limits.maxDiskMB));
  const cpu = intIn(body.cpu, limits.maxCpu);        // 0 = unlimited (only possible when the limit is 0 too)
  if (!(memory >= 64) || !(disk >= 64) || !(cpu >= 0)) throw fail('BAD_RESOURCES', 'memory and disk must be at least 64 (MB) and cpu a number (percent).');
  if (memory > limits.maxRamMB) throw fail('LIMIT_RAM', `memory is limited to ${limits.maxRamMB} MB per server.`, 403);
  if (disk > limits.maxDiskMB) throw fail('LIMIT_DISK', `disk is limited to ${limits.maxDiskMB} MB per server.`, 403);
  if (limits.maxCpu > 0 && (cpu === 0 || cpu > limits.maxCpu)) throw fail('LIMIT_CPU', `cpu must be between 1 and ${limits.maxCpu} (percent).`, 403);

  const nestId = intIn(body.nestId, 0), eggId = intIn(body.eggId, 0);
  if (Number.isNaN(nestId) || Number.isNaN(eggId) || (!!nestId !== !!eggId)) throw fail('BAD_EGG', 'Send both nestId and eggId, or neither (the default egg is used).');
  if (eggId && !eggAllowed(plan, nestId, eggId)) throw fail('EGG_NOT_ALLOWED', 'This egg is not enabled for the API.', 403);

  // server limit (checked before AND after creating the record, so two parallel requests cannot pass the limit together)
  if ((await subSvc.serversUsed(user._id)) >= limits.maxServers) throw fail('LIMIT_SERVERS', `Server limit reached (${limits.maxServers}).`, 403);
  const server = await Server.create({
    user: user._id, kind: 'server', createdVia: 'api', apiSubscription: sub._id, planName: 'API server', name, status: 'pending',
    resources: { memory, disk, cpu, databases: 0, backups: 0 }, deploymentStatus: 'In queue…', deployLog: ['› Created through the API']
  });
  if ((await subSvc.serversUsed(user._id)) > limits.maxServers) {
    await Server.deleteOne({ _id: server._id });
    throw fail('LIMIT_SERVERS', `Server limit reached (${limits.maxServers}).`, 403);
  }
  await ApiSubscription.updateOne({ _id: sub._id }, { $inc: { serversCreated: 1 } });
  queue.enqueue(() => provision({ serverId: server._id, userId: user._id, name, nestId, eggId, res: { memory, disk, cpu } }));
  return server;
};

exports.remove = async (server) => {
  if (server.pteroId) {
    try { await ptero.deleteServer(server.pteroId); }
    catch (e) { if (e.status !== 404) throw fail('PANEL_ERROR', 'Could not delete the server on the panel. Try again.', 502); }
  }
  await Server.deleteOne({ _id: server._id });
};
