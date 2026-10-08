// Starts a bot deploy. Three ways in:
//   free     - the admin marked the template FREE (one per customer)
//   coins    - OFFER only: the customer was given coins by the admin and the template has an offer price in coins
//   paid     - real money (FimiPay) -> fulfilPaid() is called by the payment service once the payment is confirmed
const Server = require('../models/Server');
const BotTemplate = require('../models/BotTemplate');
const wallet = require('./walletService');
const ptero = require('./pterodactylService');
const queue = require('./deployQueue');
const bot = require('./botDeploy');
const periodSvc = require('./periodService');

const fail = (code, message) => Object.assign(new Error(message), { code });
exports.fail = fail;

const cleanName = (name, tpl) => {
  const nm = (String(name || '').trim() || tpl.name).slice(0, 60);
  if (nm.length < 3) throw fail('BAD_NAME', 'Name must be at least 3 characters.');
  return nm;
};
const ready = () => { if (!ptero.isConfigured() || !ptero.clientConfigured()) throw fail('NOT_CONFIGURED', 'Bot hosting is not set up yet. Please contact support.'); };

function build(userId, tpl, nm, extra) {
  return Server.create(Object.assign({
    user: userId, kind: 'bot', template: tpl._id, templateName: tpl.name, planName: tpl.name, name: nm, status: 'pending',
    expiresAt: tpl.days > 0 ? periodSvc.addDays(new Date(), tpl.days) : null, periodDays: tpl.days || 0,
    resources: { memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu, databases: tpl.databases, backups: tpl.backups },
    deploymentStatus: 'In queue…', deployLog: ['› Order received']
  }, extra));
}
const enqueue = (server, tpl, nm, debitReference, refundAmount) => queue.enqueue(() => bot.deploy({ serverId: server._id, userId: server.user, templateId: tpl._id, name: nm, debitReference, refundAmount }));
exports.enqueue = enqueue;

// throws Error with .code: NOT_FOUND | NOT_CONFIGURED | BAD_NAME | ALREADY_HAVE | PAY_REQUIRED | INSUFFICIENT
exports.order = async ({ user, templateId, name, via }) => {
  const tpl = await BotTemplate.findOne({ _id: templateId, active: true });
  if (!tpl) throw fail('NOT_FOUND', 'This bot is not available.');
  ready();
  const nm = cleanName(name, tpl);

  if (tpl.free) {
    const have = await Server.countDocuments({ user: user._id, kind: 'bot', template: tpl._id, status: { $in: ['pending', 'active', 'suspended'] } });
    if (have >= 1) throw fail('ALREADY_HAVE', 'You already have this free bot. Delete it first to deploy again.');
    const server = await build(user._id, tpl, nm, { paidCoins: 0, events: [{ at: new Date(), type: 'order', text: 'Free bot' }] });
    enqueue(server, tpl, nm, 'FREE', 0);
    return { server, tpl, coins: 0 };
  }

  if (via === 'coins') {
    const price = tpl.offerCoins > 0 ? tpl.offerCoins : 1;      // gift coins work on every paid bot (1 coin unless the admin set another price)
    if (price < 1) throw fail('PAY_REQUIRED', 'This bot has no coin offer. Please pay with money.');
    if (user.coins < price) throw fail('INSUFFICIENT', `You need ${price} offer coins to deploy this bot.`);
    let debit;
    try { debit = await wallet.debitCoins(user._id, price, 'Bot deploy (offer)', { template: String(tpl._id), templateName: tpl.name, serverName: nm }); }
    catch (e) { if (e.code === 'INSUFFICIENT') throw fail('INSUFFICIENT', `You need ${price} offer coins to deploy this bot.`); throw e; }
    const server = await build(user._id, tpl, nm, { paidCoins: price, events: [{ at: new Date(), type: 'order', text: `Offer: ${price} coins` }] });
    enqueue(server, tpl, nm, debit.transaction.reference, price);
    return { server, tpl, coins: price };
  }
  throw fail('PAY_REQUIRED', 'Please pay to deploy this bot.');
};

// called once, after FimiPay confirmed the payment. Safe to call again for the same payment.
exports.fulfilPaid = async (order) => {
  let server = await Server.findOne({ paymentOrder: order._id });
  if (server) return server;
  const tpl = await BotTemplate.findById(order.template);
  if (!tpl) throw new Error('Bot template missing for paid order ' + order._id);
  ready();
  const nm = (String(order.serverName || '').trim() || tpl.name).slice(0, 60);
  server = await build(order.user, tpl, nm, { paymentOrder: order._id, paidCoins: 0, events: [{ at: new Date(), type: 'order', text: `Paid ${order.amount} ${order.currency}` }] });
  enqueue(server, tpl, nm, 'PAID-' + (order.orderId || order._id), 0);
  return server;
};

// the customer paid but the install failed: run the same install again (limited)
exports.retry = async (server) => {
  const tpl = await BotTemplate.findById(server.template);
  if (!tpl) throw fail('NOT_FOUND', 'This bot is no longer available.');
  ready();
  const ok = await Server.findOneAndUpdate({ _id: server._id, status: 'failed', retries: { $lt: 3 } }, { $set: { status: 'pending', deploymentStatus: 'In queue…' }, $inc: { retries: 1 }, $push: { deployLog: '↻ Trying again' } });
  if (!ok) throw fail('RETRY_LIMIT', 'This deploy cannot be retried any more. Please contact support.');
  enqueue(server, tpl, server.name, 'RETRY', server.paidCoins || 0);
  return server;
};
