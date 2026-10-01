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
  // user can only see their own server
  const server = await Server.findOne({ _id: req.params.id, user: req.user._id });
  if (!server) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  res.render('dashboard/server', { active: 'servers', server });
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
  if (!ptero.isConfigured()) { req.flash('error', 'Hosting is not configured yet. Please contact support.'); return res.redirect(back); }
  if (req.user.coins < plan.coins) { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }

  // 1-2. deduct coins atomically + debit transaction
  let debit;
  try {
    debit = await wallet.debitCoins(req.user._id, plan.coins, 'Server purchase', { plan: String(plan._id), planName: plan.name, serverName: name });
  } catch (e) {
    if (e.code === 'INSUFFICIENT') { req.flash('error', 'Insufficient Coins'); return res.redirect(back); }
    throw e;
  }

  // 3. server record
  const server = await Server.create({
    user: req.user._id, plan: plan._id, planName: plan.name, bot: bot ? bot._id : null, name, status: 'pending',
    resources: { memory: plan.memory, disk: plan.disk, cpu: plan.cpu, databases: plan.databases, backups: plan.backups }
  });

  try {
    // 4. Pterodactyl user  5. Pterodactyl server  6-9. save ids/status/panel url
    const pteroUserId = await ptero.ensureUser(req.user);
    const created = await ptero.createServer({ pteroUserId, plan, bot, name, externalId: server._id });
    server.pteroId = created.id;
    server.identifier = created.identifier;
    server.status = 'active';
    server.panelUrl = ptero.panelUrl(created.identifier);
    await server.save();
    req.flash('success', 'Server deployed successfully.');
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

module.exports = router;
