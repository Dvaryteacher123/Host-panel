// "Bind for ...:25567 failed: port is already allocated" -> give the server another free port and start it again.
const Server = require('../models/Server');
const ptero = require('./pterodactylService');

const PORT_ERR = /port is already allocated|Bind for .* failed|address already in use|failed programming external connectivity/i;
exports.isPortError = (line) => PORT_ERR.test(String(line || ''));

const tries = new Map();      // serverId -> automatic repairs in the last 10 minutes
const watching = new Set();

async function note(serverId, text) {
  await Server.updateOne({ _id: serverId }, { $push: { events: { $each: [{ at: new Date(), type: 'port', text }], $slice: -200 }, deployLog: { $each: ['🔧 ' + text], $slice: -120 } } }).catch(() => {});
}

// move the server to another free port and start it. force = the customer pressed the button (no limit).
exports.recover = async (server, force) => {
  const k = String(server._id);
  const n = tries.get(k) || 0;
  if (!force && n >= 3) return false;
  tries.set(k, n + 1); const t = setTimeout(() => tries.delete(k), 10 * 60000); if (t.unref) t.unref();
  const r = await ptero.moveToFreePort(server.pteroId);
  await Server.updateOne({ _id: server._id }, { $set: { port: r.to } }).catch(() => {});
  await note(server._id, `Port ${r.from} was busy - moved to port ${r.to}`);
  await new Promise((res) => setTimeout(res, 3000));          // let the panel tell the node
  await ptero.power(server.identifier, 'start');
  return r;
};

// start / restart, and keep an eye on the console for ~40 seconds: if Docker says the port is busy, repair it automatically
exports.safePower = async (server, signal) => {
  await ptero.power(server.identifier, signal);
  if (signal === 'stop' || !ptero.clientConfigured() || !server.pteroId) return;
  const k = String(server._id);
  if (watching.has(k)) return;
  watching.add(k);
  let conn = null; let armed = false; let done = false;
  const stop = () => { if (done) return; done = true; clearTimeout(timer); watching.delete(k); try { conn && conn.close(); } catch (e) { /* ignore */ } };
  const timer = setTimeout(stop, 40000);
  ptero.openConsole(server.identifier, {
    onReady: () => { setTimeout(() => { armed = true; }, 1500); },        // ignore the old log lines the panel replays first
    onLine: async (line) => {
      if (!armed || done || !exports.isPortError(line)) return;
      stop();
      try { await exports.recover(server, false); } catch (e) { console.error('[port] auto repair failed', e.message); await note(server._id, 'Could not move the port automatically: ' + e.message); }
    },
    onStatus: () => {}, onStats: () => {}, onClose: stop, onError: stop
  }).then((c) => { conn = c; if (done) c.close(); }).catch(stop);
};
