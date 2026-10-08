// Deploys a bot template for a customer: creates the Pterodactyl server, waits for the install,
// uploads + extracts the admin's ZIP, starts it, and (for WhatsApp bots) handles the phone number + pair code.
const fs = require('fs');
const path = require('path');
const Server = require('../models/Server');
const User = require('../models/User');
const BotTemplate = require('../models/BotTemplate');
const wallet = require('./walletService');
const ptero = require('./pterodactylService');
const portGuard = require('./portGuard');

const BOT_DIR = path.join(__dirname, '..', '..', 'storage', 'bots');
exports.BOT_DIR = BOT_DIR;
fs.mkdirSync(BOT_DIR, { recursive: true });

const clip = (l) => String(l).slice(0, 200);
async function addLog(serverId, lines) {
  const arr = (Array.isArray(lines) ? lines : [lines]).map(clip);
  if (arr.length) await Server.updateOne({ _id: serverId }, { $push: { deployLog: { $each: arr, $slice: -120 } } });
}
async function step(serverId, text) {
  await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: text } });
  await addLog(serverId, '› ' + text);
}
async function ev(serverId, type, text) {
  await Server.updateOne({ _id: serverId }, { $push: { events: { $each: [{ at: new Date(), type, text: clip(text) }], $slice: -200 } } }).catch(() => {});
}
exports.event = ev;

function friendly(err) {
  const m = String((err && err.message) || err || '');
  if (/free port|allocation/i.test(m)) return 'No free ports on the server right now. Please try again later.';
  if (/429|Too Many/i.test(m)) return 'The hosting panel is very busy. Please try again in a minute.';
  if (/allocation|No nodes|no available/i.test(m)) return 'No free space on the servers right now. Please try again later.';
  if (/CLIENT_API_KEY/i.test(m)) return 'Bot hosting is not fully set up yet. Please contact support.';
  if (/ZIP/i.test(m)) return 'The bot files could not be installed. Please contact support.';
  return 'Could not deploy the bot. Please try again or contact support.';
}

// ---------- main deploy job (runs in the deploy queue) ----------
exports.deploy = async ({ serverId, userId, templateId, name, debitReference, refundAmount }) => {
  let tpl = null; let pteroIdCreated = null;
  try {
    const [user, server] = await Promise.all([User.findById(userId), Server.findById(serverId)]);
    tpl = await BotTemplate.findById(templateId).lean();
    if (!user || !server || !tpl) throw new Error('Order data missing.');
    if (!ptero.clientConfigured()) throw new Error('PTERODACTYL_CLIENT_API_KEY is required to upload bot files.');
    const zipPath = path.join(BOT_DIR, path.basename(tpl.zipFile));
    if (!fs.existsSync(zipPath)) throw new Error('Bot ZIP file is missing on the website server.');

    await step(serverId, 'Preparing your account…');
    const acct = await ptero.ensureUser(user);
    if (acct.created) await User.updateOne({ _id: userId }, { $set: { pteroManaged: true } });

    await step(serverId, 'Creating your server…');
    const created = await ptero.createServer({
      pteroUserId: acct.id, name, externalId: server._id,
      plan: { memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu, databases: tpl.databases, backups: tpl.backups, nestId: tpl.nestId, eggId: tpl.eggId, dockerImage: tpl.dockerImage, startup: tpl.startup },
      bot: { environment: tpl.environment || {} }
    });
    pteroIdCreated = created.id;
    await Server.updateOne({ _id: serverId }, { $set: { pteroId: created.id, identifier: created.identifier, port: created.port || null, panelPassword: acct.generatedPassword || '' } });
    await addLog(serverId, '✅ Server created');

    await step(serverId, 'Installing the system (about 1 minute)…');
    await ptero.waitUntilReady(created.identifier);
    await addLog(serverId, '✅ System installed');

    await step(serverId, 'Uploading your bot files…');
    let count = 0;
    await ptero.uploadArchiveFile(created.identifier, zipPath, async (lines) => {
      const keep = [];
      lines.forEach((l) => { if (/^[✔📁]/.test(l)) count++; else keep.push(l); });
      if (keep.length) await addLog(serverId, keep);
    });
    await addLog(serverId, `✅ Bot files ready${count ? ' (' + count + ' items)' : ''}`);

    const set = { status: 'active', deploymentStatus: 'Your bot is ready.', pairStatus: tpl.pairing ? 'need_phone' : 'none' };
    await Server.updateOne({ _id: serverId }, { $set: set });
    await BotTemplate.updateOne({ _id: tpl._id }, { $inc: { deploys: 1 } });
    if (tpl.pairing) {
      await addLog(serverId, '📱 Enter your WhatsApp number to get your pair code.');
      await ev(serverId, 'deploy', 'Deploy finished - waiting for your phone number');
    } else {
      await portGuard.safePower({ _id: serverId, identifier: created.identifier, pteroId: created.id }, 'start').catch((e) => console.error('[bot] start failed', e.message));
      await addLog(serverId, '🚀 Bot started');
      await ev(serverId, 'deploy', 'Deploy finished - bot started');
    }
  } catch (err) {
    console.error('[bot deploy] FAILED server', String(serverId), '-', err && err.message);
    const flipped = await Server.findOneAndUpdate({ _id: serverId, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: friendly(err) }, $push: { deployLog: { $each: ['❌ ' + friendly(err)], $slice: -120 } } });
    if (pteroIdCreated) { try { await ptero.deleteServer(pteroIdCreated); } catch (e) { /* admin can clean up in the panel */ } }
    if (flipped) {
      await ev(serverId, 'failed', friendly(err));
      try {
        const back = Number(refundAmount) || 0;
        if (back >= 1) {
          await wallet.refundCoins(userId, back, 'Bot deploy refund', { serverName: name, templateName: tpl ? tpl.name : '', debitReference });
          await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: friendly(err) + ' Coins refunded.' } });
        }
      } catch (e) { console.error('CRITICAL: bot refund failed', String(userId), e); }
    }
  }
};

// ---------- phone number + pair code ----------
const watchers = new Map();
const PROMPT = /(number|phone|namba|whatsapp|simu)/i;

function findCode(line, custom) {
  if (custom) { try { const m = line.match(new RegExp(custom)); return m ? String(m[1] || m[0]).trim() : null; } catch (e) { return null; } }
  let m = line.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  if (m) return m[1];
  m = line.match(/[Cc]ode\W{0,14}([A-Z0-9]{8})\b/);
  return m ? m[1].slice(0, 4) + '-' + m[1].slice(4) : null;
}

function stopWatch(serverId) { const w = watchers.get(String(serverId)); if (w) w.stop(); }
exports.stopWatch = stopWatch;

// Opens the console, (re)starts the bot, types the number if the bot asks for it and captures the pair code.
exports.startPairing = async (serverId, phone) => {
  const server = await Server.findById(serverId);
  if (!server || !server.identifier || server.status !== 'active') throw new Error('Server is not ready.');
  const tpl = server.template ? await BotTemplate.findById(server.template).lean() : null;
  if (!tpl) throw new Error('Bot template no longer exists.');
  stopWatch(serverId);

  await Server.updateOne({ _id: serverId }, { $set: { phone, pairStatus: 'pairing', pairCode: '', pairAt: new Date() } });
  await ev(serverId, 'pair', 'Pair code requested for +' + phone.slice(0, 3) + '******' + phone.slice(-2));

  const viaEnv = !!tpl.phoneVar;
  if (viaEnv) await ptero.setEnvVar(server.pteroId, tpl.phoneVar, phone);

  let sent = viaEnv; let armed = false; let done = false; let conn = null; let fallback = null;
  const id = String(serverId);
  const stop = () => { if (done) return; done = true; clearTimeout(hard); clearTimeout(fallback); try { conn && conn.close(); } catch (e) { /* ignore */ } watchers.delete(id); };
  const hard = setTimeout(async () => {
    await Server.updateOne({ _id: serverId, pairStatus: 'pairing' }, { $set: { pairStatus: 'need_phone' } }).catch(() => {});
    await addLog(serverId, '⚠️ No pair code appeared. Check the number and try again.').catch(() => {});
    stop();
  }, 10 * 60 * 1000);
  const typeNumber = async () => { if (sent || done) return; sent = true; try { await ptero.sendCommand(server.identifier, phone); await addLog(serverId, '📱 Number sent to the bot'); } catch (e) { console.error('[bot] send number failed', e.message); } };

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Console did not connect.')), 20000);
    ptero.openConsole(server.identifier, {
      onReady: () => { setTimeout(() => { armed = true; clearTimeout(t); resolve(); }, 1500); },
      onLine: async (line) => {
        if (!armed || done) return;
        if (portGuard.isPortError(line)) {      // Docker: port busy -> new port, start again (the pairing watcher stays open)
          try { await portGuard.recover(server, false); } catch (e) { console.error('[port] repair during pairing failed', e.message); }
          return;
        }
        if (!sent && PROMPT.test(line)) return typeNumber();
        const code = findCode(line, tpl.codeRegex);
        if (code) {
          const r = await Server.updateOne({ _id: serverId, pairStatus: 'pairing' }, { $set: { pairCode: code, pairStatus: 'code_ready' } });
          if (r.modifiedCount) { await addLog(serverId, '🔑 Pair code is ready'); await ev(serverId, 'pair', 'Pair code generated'); }
        } else if (/(connected|logged in|paired|login success|successfully)/i.test(line)) {
          const r = await Server.updateOne({ _id: serverId, pairStatus: 'code_ready' }, { $set: { pairStatus: 'paired' } });
          if (r.modifiedCount) { await addLog(serverId, '✅ WhatsApp connected'); await ev(serverId, 'paired', 'WhatsApp linked successfully'); stop(); }
        }
      },
      onStatus: () => {}, onStats: () => {}, onClose: () => stop(), onError: () => stop()
    }).then((c) => { conn = c; if (done) c.close(); }).catch((e) => { clearTimeout(t); reject(e); });
  }).catch((e) => { stop(); throw e; });

  watchers.set(id, { stop });
  // (no automatic typing after a delay: every bot has its own questions - the customer can answer them himself in the console box)
  let state = 'offline'; try { state = await ptero.powerState(server.identifier); } catch (e) { /* assume offline */ }
  await ptero.power(server.identifier, state === 'offline' ? 'start' : 'restart');
  await addLog(serverId, '🚀 Starting the bot…');
  await ev(serverId, 'start', 'Bot started for pairing');
};
