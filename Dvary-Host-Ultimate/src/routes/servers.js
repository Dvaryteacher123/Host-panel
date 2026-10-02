const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Plan = require('../models/Plan');
const BotTemplate = require('../models/BotTemplate');
const User = require('../models/User');
const queue = require('../services/deployQueue');
const Transaction = require('../models/Transaction');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

router.get('/servers', wrap(async (req, res) => {
  const servers = await Server.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200).lean();
  res.render('dashboard/servers', { active: 'servers', servers });
}));

router.get('/deploys', wrap(async (req, res) => {
  const deploys = await Server.find({ user: req.user._id, bot: { $ne: null } }).sort({ createdAt: -1 }).limit(200)
    .select('name planName status deploymentStatus bot identifier createdAt').populate('bot', 'name imageUrl').lean();
  res.render('dashboard/deploys', { active: 'deploys', deploys });
}));

router.get('/server/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id }).populate('bot', 'name phoneVar imageUrl');
  if (!server) return res.status(404).render('error', { code: 404, message: 'Page not found.' });

  res.render('dashboard/server', { active: 'servers', server, consoleReady: ptero.clientConfigured() });
}));

router.post('/buy', wrap(async (req, res) => {
  const back = '/dashboard/store';
  const name = String(req.body.name || '').trim();
  // keep what the customer typed so the form is never cleared when something goes wrong
  req.session.oldDeploy = { name, plan: String(req.body.plan || ''), bot: String(req.body.bot || '') };
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  if (!validId(req.body.plan)) { req.flash('error', 'Select a plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: req.body.plan, active: true });
  if (!plan) { req.flash('error', 'This plan is not available.'); return res.redirect(back); }

  let bot = null;
  if (req.body.bot) {
    if (!validId(req.body.bot)) { req.flash('error', 'Invalid service.'); return res.redirect(back); }
    bot = await BotTemplate.findOne({ _id: req.body.bot, active: true });
    if (!bot) { req.flash('error', 'This service is not available.'); return res.redirect(back); }
  }

  if (bot && !bot.archivePath) {
    req.flash('error', 'This bot is not configured yet. The admin must upload its ZIP file.');
    return res.redirect(back);
  }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }
  if (bot && !ptero.clientConfigured()) { req.flash('error', 'Bot deployment is not configured yet. Admin must set the Pterodactyl Client API key.'); return res.redirect(back); }
  if (req.user.coins < plan.coins) { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }

  let debit;
  try {
    debit = await wallet.debitCoins(req.user._id, plan.coins, 'Server purchase', { plan: String(plan._id), planName: plan.name, serverName: name });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }
    throw e;
  }

  const server = await Server.create({
    user: req.user._id, plan: plan._id, planName: plan.name, bot: bot ? bot._id : null, name, status: 'pending',
    resources: { memory: plan.memory, disk: plan.disk, cpu: plan.cpu, databases: plan.databases, backups: plan.backups },
    deploymentStatus: 'In queue…'
  });

  delete req.session.oldDeploy;
  // Heavy work runs in the background; the customer is sent to his server page right away.
  const ref = debit.transaction.reference;
  queue.enqueue(() => runDeploy({ serverId: server._id, userId: req.user._id, planId: plan._id, botId: bot ? bot._id : null, name, debitReference: ref }));
  req.flash('success', 'Deploying your server… this page updates by itself.');
  return res.redirect('/dashboard/server/' + server._id);
}));

async function addLog(serverId, lines) {
  const arr = (Array.isArray(lines) ? lines : [lines]).map((l) => String(l).slice(0, 200));
  if (!arr.length) return;
  await Server.updateOne({ _id: serverId }, { $push: { deployLog: { $each: arr, $slice: -400 } } });
}
async function setStep(serverId, text) {
  await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: text } });
  await addLog(serverId, '› ' + text);
}

function friendlyError(err) {
  const m = String((err && err.message) || err || '');
  if (/429|Too Many/i.test(m)) return 'The hosting panel is very busy right now. Please try again in a minute.';
  if (/did not become ready|installation failed/i.test(m)) return 'The server took too long to install. Please try again.';
  if (/ZIP|larger than/i.test(m)) return 'The bot files could not be prepared. Contact support.';
  return 'Deployment failed. Please try again or contact support.';
}

async function runDeploy({ serverId, userId, planId, botId, name, debitReference }) {
  let plan = null;
  try {
    const [user, server] = await Promise.all([User.findById(userId), Server.findById(serverId)]);
    plan = await Plan.findById(planId);
    if (!user || !server || !plan) throw new Error('Deployment data missing.');
    const bot = botId ? await BotTemplate.findById(botId) : null;

    await setStep(serverId, 'Creating server…');
    const pteroUserResult = await ptero.ensureUser(user);
    const created = await ptero.createServer({ pteroUserId: pteroUserResult.id, plan, bot, name, externalId: server._id, repositoryUrl: '' });
    await Server.updateOne({ _id: serverId }, { $set: { pteroId: created.id, identifier: created.identifier, deploymentStatus: 'Installing server…' } });
    await ptero.waitUntilReady(created.identifier);

    if (bot && bot.archivePath) {
      await setStep(serverId, 'Uploading bot files…');
      await ptero.uploadArchiveFile(created.identifier, bot.archivePath, (lines) => addLog(serverId, lines));
    }
    if (!ptero.clientConfigured()) throw new Error('Pterodactyl Client API is not configured.');

    if (bot && bot.phoneVar) {
      await Server.updateOne({ _id: serverId }, { $set: { status: 'active', deploymentStatus: 'Waiting for phone number…' } });
      await addLog(serverId, '✅ Done. Enter your number in the console.');
    } else {
      await setStep(serverId, 'Starting bot…');
      await ptero.power(created.identifier, 'start');
      await Server.updateOne({ _id: serverId }, { $set: { status: 'active', deploymentStatus: 'Deployed successfully' } });
      await addLog(serverId, '✅ Deployed successfully');
    }
  } catch (err) {
    console.error('[deploy] FAILED for server', String(serverId), '-', err && err.message);
    // only the job that flips pending -> failed refunds, so a refund can never happen twice
    const flipped = await Server.findOneAndUpdate({ _id: serverId, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: friendlyError(err) }, $push: { deployLog: { $each: ['❌ ' + friendlyError(err)], $slice: -400 } } });
    if (flipped && plan) {
      try {
        await wallet.refundCoins(userId, plan.coins, 'Server deployment refund', { serverName: name, planName: plan.name, debitReference });
        await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: friendlyError(err) + ' Coins refunded.' } });
      } catch (refundErr) {
        console.error('CRITICAL: refund failed for user', String(userId), 'amount', plan.coins, refundErr);
      }
    }
  }
}

// If the app restarted in the middle of a deployment, fail + refund those orphaned servers.
router.recoverStuck = async () => {
  try {
    const cutoff = new Date(Date.now() - 20 * 60 * 1000);
    const stuck = await Server.find({ status: 'pending', createdAt: { $lt: cutoff } }).populate('plan');
    for (const sv of stuck) {
      const flipped = await Server.findOneAndUpdate({ _id: sv._id, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: 'Deployment was interrupted. Coins refunded.' } });
      if (flipped && sv.plan) {
        await wallet.refundCoins(sv.user, sv.plan.coins, 'Server deployment refund', { serverName: sv.name, planName: sv.plan.name }).catch((e) => console.error('recover refund failed', e.message));
      }
    }
  } catch (e) { console.error('recoverStuck failed', e.message); }
};

// ---------- helpers for the per-server tools ----------
async function ownServer(req, res) {
  if (!validId(req.params.id)) { res.status(404).render('error', { code: 404, message: 'Page not found.' }); return null; }
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id }).populate('bot', 'name phoneVar');
  if (!server) { res.status(404).render('error', { code: 404, message: 'Page not found.' }); return null; }
  return server;
}
const here = (server) => '/dashboard/server/' + server._id;

// customer deletes his own server (no refund)
router.post('/server/:id/delete', wrap(async (req, res) => {
  const server = await ownServer(req, res); if (!server) return;
  if (server.status === 'suspended') { req.flash('error', 'This server is suspended. Contact support.'); return res.redirect(here(server)); }
  if (server.pteroId) {
    if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured. Please contact support.'); return res.redirect(here(server)); }
    try { await ptero.deleteServer(server.pteroId); } catch (e) {
      if (e.status !== 404) { console.error('customer delete failed', e.message); req.flash('error', 'Could not delete the server on the panel. Please try again.'); return res.redirect(here(server)); }
    }
  }
  await Server.deleteOne({ _id: server._id });
  req.flash('success', 'Server deleted.');
  res.redirect('/dashboard/servers');
}));

// Customer enters his WhatsApp number. Two modes:
//  - template has a "Phone variable" that exists on the egg -> saved as env variable, bot restarts
//  - otherwise (recommended) -> the number is typed into the bot console, exactly like answering its
//    "Enter your number" prompt, so the pairing code shows up in the live console.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
router.post('/server/:id/phone', wrap(async (req, res) => {
  const ajax = req.get('x-requested-with') === 'fetch';
  const server = await ownServer(req, res); if (!server) return;
  const done = (ok, type, msg) => {
    if (ajax) return res.status(ok ? 200 : 400).json({ ok, message: msg });
    req.flash(type, msg); return res.redirect(here(server));
  };
  if (!server.bot || !server.pteroId || !server.identifier) return done(false, 'error', 'This server does not support phone pairing.');
  if (server.status !== 'active') return done(false, 'error', 'This server is not active.');
  const digits = String(req.body.phone || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return done(false, 'error', 'Enter your number with country code, e.g. 255712345678.');

  // mode 1: egg variable
  const phoneVar = server.bot.phoneVar;
  if (phoneVar) {
    try {
      await ptero.setEnvVar(server.pteroId, phoneVar, digits);
      server.phone = digits; await server.save();
      let started = false;
      if (ptero.clientConfigured()) { try { await ptero.power(server.identifier, 'restart'); started = true; } catch (e) { console.error('restart failed', e.message); } }
      return done(true, 'success', started ? 'Number saved. Bot is restarting, watch for the pairing code here.' : 'Number saved. Start the server to apply it.');
    } catch (e) {
      if (e.code !== 'novar') { console.error('phone update failed', e.message); return done(false, 'error', 'Could not save the number. Please try again.'); }
      // variable does not exist on the egg -> fall through to console mode
    }
  }

  // mode 2: type the number into the console
  if (!ptero.clientConfigured()) return done(false, 'error', 'Console is not enabled yet. Contact support.');
  try {
    let state = await ptero.powerState(server.identifier);
    if (state === 'offline' || state === 'stopping') {
      await ptero.power(server.identifier, 'start');
      for (let i = 0; i < 20 && state !== 'running'; i++) { await sleep(2000); state = await ptero.powerState(server.identifier); }
      await sleep(7000); // let the bot print its "enter number" prompt
    }
    await ptero.sendCommand(server.identifier, digits);
    server.phone = digits;
    server.deploymentStatus = 'Number sent — waiting for pairing code';
    await server.save();
    return done(true, 'success', 'Number sent to the bot. The pairing code will appear in the console.');
  } catch (e) {
    console.error('console send failed', e.message);
    return done(false, 'error', 'Could not send the number. Press RESTART, wait for the bot to ask for the number, then try again.');
  }
}));

// start / stop / restart (JSON, called by fetch)
router.post('/server/:id/power', wrap(async (req, res) => {
  const server = await ownServer(req, res); if (!server) return;
  const signal = String(req.body.signal || '');
  if (!['start', 'stop', 'restart', 'kill'].includes(signal) || !server.identifier || server.status !== 'active' || !ptero.clientConfigured()) return res.status(400).json({ ok: false });
  try { await ptero.power(server.identifier, signal); res.json({ ok: true }); } catch (e) { console.error('power failed', e.message); res.status(502).json({ ok: false }); }
}));

// live console (Server-Sent Events). Browser -> this app -> Wings websocket.
const openConsoles = new Map();
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
router.get('/server/:id/console', wrap(async (req, res) => {
  const server = await ownServer(req, res); if (!server) return;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const fatal = (code) => { send('fatal', { code }); res.end(); };
  if (!ptero.clientConfigured()) return fatal('noclient');
  if (!server.identifier || server.status !== 'active') return fatal('inactive');
  const uid = String(req.user._id);
  if ((openConsoles.get(uid) || 0) >= 3) return fatal('limit');
  openConsoles.set(uid, (openConsoles.get(uid) || 0) + 1);

  let conn = null; let done = false;
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n'); }, 20000);
  const maxTimer = setTimeout(() => fatal('timeout'), 30 * 60 * 1000);
  const cleanup = () => {
    if (done) return; done = true;
    clearInterval(heartbeat); clearTimeout(maxTimer);
    if (conn) conn.close();
    openConsoles.set(uid, Math.max(0, (openConsoles.get(uid) || 1) - 1));
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  try {
    conn = await ptero.openConsole(server.identifier, {
      onReady: () => send('ready', 1),
      onLine: (l) => send('line', l.replace(ANSI, '')),
      onStatus: (st) => send('status', st),
      onStats: (st) => send('stats', { cpu: st.cpu_absolute, mem: st.memory_bytes }),
      onClose: () => fatal('closed'),
      onError: (m) => { console.error('console websocket:', m); fatal('error'); }
    });
    if (done) conn.close();
  } catch (e) { console.error('console open failed', e.message); fatal('error'); }
}));

module.exports = router;
