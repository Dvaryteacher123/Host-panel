const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Plan = require('../models/Plan');
const BotTemplate = require('../models/BotTemplate');
const Transaction = require('../models/Transaction');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

router.get('/servers', wrap(async (req, res) => {
  const servers = await Server.find({ user: req.user._id }).sort({ createdAt: -1 });
  res.render('dashboard/servers', { active: 'servers', servers });
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
    deploymentStatus: 'Creating server…'
  });

  try {
    const pteroUserResult = await ptero.ensureUser(req.user);
    const pteroUserId = pteroUserResult.id;
    const generatedPassword = pteroUserResult.generatedPassword;

    const created = await ptero.createServer({ pteroUserId, plan, bot, name, externalId: server._id, repositoryUrl: '' });
    server.pteroId = created.id;
    server.identifier = created.identifier;
    server.deploymentStatus = 'Preparing server…';
    await server.save();
    await ptero.waitUntilReady(created.identifier);

    if (bot && bot.archivePath) {
      server.deploymentStatus = 'Uploading bot files…';
      await server.save();
      await ptero.uploadArchiveFile(created.identifier, bot.archivePath);
      server.deploymentStatus = 'Starting bot…';
      await server.save();
    }

    if (!ptero.clientConfigured()) throw new Error('Pterodactyl Client API is not configured.');
    server.status = 'active';
    if (bot && bot.phoneVar) {
      server.deploymentStatus = 'Waiting for phone number…';
      await server.save();
      req.flash('success', 'Bot deployed. Enter your phone number to generate the pairing code.');
    } else {
      await ptero.power(created.identifier, 'start');
      server.deploymentStatus = 'Deployed successfully';
      await server.save();
      req.flash('success', bot ? 'Deployment complete. Bot is starting.' : 'Server deployed successfully.');
    }
    return res.redirect('/dashboard/server/' + server._id);
    return res.redirect('/dashboard/server/' + server._id);
  } catch (err) {
    let pteroErrorMsg = '';
    if (err.response && err.response.data) {
      if (typeof err.response.data === 'string') {
        pteroErrorMsg = err.response.data;
      } else if (err.response.data.errors && err.response.data.errors.length > 0) {
        pteroErrorMsg = err.response.data.errors.map(e => e.detail || e.code).join(', ');
      } else {
        pteroErrorMsg = JSON.stringify(err.response.data);
      }
    } else {
      pteroErrorMsg = err.message;
    }

    console.error('====== PTERODACTYL DEPLOYMENT ERROR DETAILS ======');
    console.error('Parsed Error:', pteroErrorMsg);
    console.error('==================================================');

    try {
      await wallet.refundCoins(req.user._id, plan.coins, 'Server deployment refund', {
        serverName: name, planName: plan.name, debitReference: debit.transaction.reference
      });
      await Server.deleteOne({ _id: server._id });
      req.flash('error', `Deployment Failed: ${pteroErrorMsg}. Coins refunded.`);
    } catch (refundErr) {
      console.error('CRITICAL: refund failed for user', String(req.user._id), 'amount', plan.coins, refundErr);
      await Server.updateOne({ _id: server._id }, { status: 'failed' }).catch(() => {});
      req.flash('error', 'Server deployment failed and refund encountered an issue. Please contact support.');
    }
    return res.redirect(back);
  }
}));


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

// phone number -> egg variable (WhatsApp pairing) without opening the panel
router.post('/server/:id/phone', wrap(async (req, res) => {
  const ajax = req.get('x-requested-with') === 'fetch';
  const done = (ok, type, msg) => {
    if (ajax) return res.status(ok ? 200 : 400).json({ ok, message: msg });
    req.flash(type, msg); return res.redirect(here(server));
  };
  const server = await ownServer(req, res); if (!server) return;
  const phoneVar = server.bot && server.bot.phoneVar;
  if (!phoneVar || !server.pteroId) return done(false, 'error', 'This server does not support phone pairing.');
  const digits = String(req.body.phone || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return done(false, 'error', 'Enter your number with country code, e.g. 255712345678.');
  try {
    await ptero.setEnvVar(server.pteroId, phoneVar, digits);
  } catch (e) {
    console.error('phone update failed', e.message);
    return done(false, 'error', e.code === 'novar' ? 'The bot template points to a variable that this egg does not have. Tell the admin.' : 'Could not save the number on the panel. Please try again.');
  }
  server.phone = digits;
  await server.save();
  let started = false;
  if (ptero.clientConfigured() && server.identifier) {
    try {
      await ptero.power(server.identifier, 'restart');
      started = true;
      server.deploymentStatus = 'Bot started — waiting for pairing code';
      await server.save();
    } catch (e) {
      console.error('start failed', e.message);
    }
  }
  return done(true, 'success', started ? 'Number saved. Bot is restarting, watch for the pairing code here.' : 'Number saved. Start the server to apply it.');
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
