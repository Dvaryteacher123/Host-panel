const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const Server = require('../models/Server');
const Plan = require('../models/Plan');
const User = require('../models/User');
const queue = require('../services/deployQueue');
const Transaction = require('../models/Transaction');
const wallet = require('../services/walletService');
const ptero = require('../services/pterodactylService');
const periodSvc = require('../services/periodService');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

router.get('/servers', wrap(async (req, res) => {
  const servers = await Server.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(200).lean();
  res.render('dashboard/servers', { active: 'servers', servers });
}));

router.get('/server/:id', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id });
  if (!server) return res.status(404).render('error', { code: 404, message: 'Page not found.' });

  // the generated panel password is shown ONE time (after the server is ready), then wiped
  let panelPassword = '';
  if (server.panelPassword && server.status === 'active') {
    panelPassword = server.panelPassword;
    await Server.updateOne({ _id: server._id }, { $set: { panelPassword: '' } });
  }
  const panelBase = (res.locals.site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, '');
  res.render('dashboard/server', {
    active: 'servers', server, consoleReady: ptero.clientConfigured(),
    panelBase, panelPassword, canResetPassword: !!req.user.pteroManaged,
    graceDays: require('../services/expiryService').graceDays(),
    canRenew: !!(server.expiresAt && !server.isFree && server.plan && (await Plan.findById(server.plan).lean().then((pl) => pl && periodSvc.list(pl).some((r) => !r.free && (r.coins > 0 || r.priceTZS > 0 || Object.keys(r.prices).length)))))
  });
}));

// new password for the customer's own panel account (only for accounts this site created)
router.post('/server/:id/panel-password', wrap(async (req, res) => {
  const server = await ownServer(req, res); if (!server) return;
  const user = await User.findById(req.user._id);
  if (!user || !user.pteroUserId || !user.pteroManaged) { req.flash('error', 'Your panel account was not created here, so its password cannot be reset from this site.'); return res.redirect('/dashboard/server/' + server._id); }
  const pw = crypto.randomBytes(12).toString('base64url') + 'aA1';
  try { await ptero.resetUserPassword(user.pteroUserId, pw); } catch (e) {
    console.error('panel password reset failed', e.message);
    req.flash('error', 'Could not reset the panel password. Please try again.'); return res.redirect('/dashboard/server/' + server._id);
  }
  await Server.updateOne({ _id: server._id }, { $set: { panelPassword: pw } });
  req.flash('success', 'New panel password created. It is shown below one time only.');
  res.redirect('/dashboard/server/' + server._id);
}));

router.post('/buy', wrap(async (req, res) => {
  const back = validId(req.body.plan) ? '/dashboard/plan/' + req.body.plan : '/dashboard/store';
  const name = String(req.body.name || '').trim();
  // keep what the customer typed so the form is never cleared when something goes wrong
  req.session.oldDeploy = { name, plan: String(req.body.plan || '') };
  if (name.length < 3 || name.length > 60) { req.flash('error', 'Server name must be 3-60 characters.'); return res.redirect(back); }
  if (!validId(req.body.plan)) { req.flash('error', 'Select a plan.'); return res.redirect(back); }
  const plan = await Plan.findOne({ _id: req.body.plan, active: true, kind: { $ne: 'admin' } });
  if (!plan) { req.flash('error', 'This plan is not available.'); return res.redirect(back); }
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }

  // duration (plans with durations: 1 day free, 1 month, 1 year ...)
  let period = null;
  if (periodSvc.list(plan).length) {
    period = periodSvc.pick(plan, req.body.period);
    if (!period) { req.flash('error', 'Choose a duration.'); return res.redirect(back); }
  }
  const price = period ? period.coins : plan.coins;
  const isFree = !!(period && period.free);
  if (!isFree && price < 1) { req.flash('error', 'This duration is paid with money. Use the money button.'); return res.redirect(back); }
  if (!isFree && req.user.coins < price) { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }

  let debit = null;
  if (isFree) {
    // one free trial per account
    const got = await User.findOneAndUpdate({ _id: req.user._id, freeUsed: { $ne: true } }, { $set: { freeUsed: true } });
    if (!got) { req.flash('error', 'You already used your free trial server. Choose a paid duration.'); return res.redirect(back); }
  } else {
    try {
      debit = await wallet.debitCoins(req.user._id, price, 'Server purchase', { plan: String(plan._id), planName: plan.name, serverName: name, period: period ? period.label : '' });
    } catch (e) {
      if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }
      throw e;
    }
  }

  const server = await Server.create({
    user: req.user._id, plan: plan._id, planName: plan.name, name, status: 'pending', paidCoins: price,
    expiresAt: period ? periodSvc.addDays(new Date(), period.days) : null, periodDays: period ? period.days : 0, isFree,
    resources: { memory: plan.memory, disk: plan.disk, cpu: plan.cpu, databases: plan.databases, backups: plan.backups },
    deploymentStatus: 'In queue…'
  });

  delete req.session.oldDeploy;
  queue.enqueue(() => runProvision({ serverId: server._id, userId: req.user._id, planId: plan._id, name, debitReference: debit ? debit.transaction.reference : 'FREE-TRIAL', refundAmount: price, freeClaim: isFree }));
  req.flash('success', 'Creating your server… this page updates by itself.');
  return res.redirect('/dashboard/server/' + server._id);
}));

async function addLog(serverId, lines) {
  const arr = (Array.isArray(lines) ? lines : [lines]).map((l) => String(l).slice(0, 200));
  if (!arr.length) return;
  await Server.updateOne({ _id: serverId }, { $push: { deployLog: { $each: arr, $slice: -100 } } });
}
async function setStep(serverId, text) {
  await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: text } });
  await addLog(serverId, '› ' + text);
}

function friendlyError(err) {
  const m = String((err && err.message) || err || '');
  if (/429|Too Many/i.test(m)) return 'The hosting panel is very busy right now. Please try again in a minute.';
  if (/allocation|No nodes|no available/i.test(m)) return 'No free space on the servers right now. Please try again later.';
  return 'Could not create the server. Please try again or contact support.';
}

// Creates the panel account (email + password) and the server owned by the customer.
async function runProvision({ serverId, userId, planId, name, debitReference, refundAmount, freeClaim }) {
  let plan = null;
  try {
    const [user, server] = await Promise.all([User.findById(userId), Server.findById(serverId)]);
    plan = await Plan.findById(planId);
    if (!user || !server || !plan) throw new Error('Order data missing.');

    await setStep(serverId, 'Creating your panel account…');
    const acct = await ptero.ensureUser(user);
    if (acct.created) await User.updateOne({ _id: userId }, { $set: { pteroManaged: true } });

    await setStep(serverId, 'Creating your server…');
    const created = await ptero.createServer({ pteroUserId: acct.id, plan, bot: null, name, externalId: server._id });
    await Server.updateOne({ _id: serverId }, { $set: {
      pteroId: created.id, identifier: created.identifier, status: 'active', panelPassword: acct.generatedPassword || '',
      deploymentStatus: 'Server created. It finishes installing in about a minute.'
    } });
    await addLog(serverId, '✅ Server created');
  } catch (err) {
    console.error('[provision] FAILED for server', String(serverId), '-', err && err.message);
    // only the job that flips pending -> failed refunds, so a refund can never happen twice
    const flipped = await Server.findOneAndUpdate({ _id: serverId, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: friendlyError(err) }, $push: { deployLog: { $each: ['❌ ' + friendlyError(err)], $slice: -100 } } });
    if (flipped && freeClaim) await User.updateOne({ _id: userId }, { $set: { freeUsed: false } }).catch(() => {});   // failed install does not burn the free trial
    if (flipped && plan) {
      try {
        const back = refundAmount != null ? refundAmount : plan.coins;
        if (back >= 1) await wallet.refundCoins(userId, back, 'Server purchase refund', { serverName: name, planName: plan.name, debitReference });
        await Server.updateOne({ _id: serverId }, { $set: { deploymentStatus: friendlyError(err) + (back >= 1 ? ' Coins refunded.' : '') } });
      } catch (refundErr) {
        console.error('CRITICAL: refund failed for user', String(userId), 'amount', plan.coins, refundErr);
      }
    }
  }
}

router.runProvision = runProvision;   // also used by automatic payments (services/paymentService.js)

// If the app restarted in the middle of an order, fail + refund those orphaned servers.
router.recoverStuck = async () => {
  try {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const stuck = await Server.find({ status: 'pending', createdAt: { $lt: cutoff } }).populate('plan');
    for (const sv of stuck) {
      const flipped = await Server.findOneAndUpdate({ _id: sv._id, status: 'pending' }, { $set: { status: 'failed', deploymentStatus: 'Order was interrupted. Coins refunded.' } });
      const back = sv.paidCoins != null ? sv.paidCoins : (sv.plan ? sv.plan.coins : 0);
      if (flipped && sv.plan && back >= 1) {
        await wallet.refundCoins(sv.user, back, 'Server purchase refund', { serverName: sv.name, planName: sv.plan.name }).catch((e) => console.error('recover refund failed', e.message));
      }
    }
  } catch (e) { console.error('recoverStuck failed', e.message); }
};

// ---------- helpers for the per-server tools ----------
async function ownServer(req, res) {
  if (!validId(req.params.id)) { res.status(404).render('error', { code: 404, message: 'Page not found.' }); return null; }
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id });
  if (!server) { res.status(404).render('error', { code: 404, message: 'Page not found.' }); return null; }
  return server;
}
const here = (server) => '/dashboard/server/' + server._id;

// customer deletes his own server (no refund)
router.post('/server/:id/delete', wrap(async (req, res) => {
  const server = await ownServer(req, res); if (!server) return;
  if (server.status === 'suspended' && server.suspendReason !== 'expired') { req.flash('error', 'This server is suspended. Contact support.'); return res.redirect(here(server)); }
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
