// One place that "buys + queues" a bot deploy. Used by the website AND the public API,
// so coins, refunds and limits behave exactly the same everywhere.
const Server = require('../models/Server');
const BotTemplate = require('../models/BotTemplate');
const wallet = require('./walletService');
const ptero = require('./pterodactylService');
const queue = require('./deployQueue');
const bot = require('./botDeploy');
const periodSvc = require('./periodService');

const fail = (code, message) => Object.assign(new Error(message), { code });
exports.fail = fail;

// throws Error with .code: NOT_FOUND | NOT_CONFIGURED | BAD_NAME | ALREADY_HAVE | INSUFFICIENT
exports.order = async ({ user, templateId, name }) => {
  const tpl = await BotTemplate.findOne({ _id: templateId, active: true });
  if (!tpl) throw fail('NOT_FOUND', 'This bot is not available.');
  if (!ptero.isConfigured() || !ptero.clientConfigured()) throw fail('NOT_CONFIGURED', 'Bot hosting is not set up yet. Please contact support.');
  const nm = (String(name || '').trim() || tpl.name).slice(0, 60);
  if (nm.length < 3) throw fail('BAD_NAME', 'Name must be at least 3 characters.');

  const price = tpl.coins;
  if (price < 1) {
    const have = await Server.countDocuments({ user: user._id, kind: 'bot', template: tpl._id, status: { $in: ['pending', 'active', 'suspended'] } });
    if (have >= 1) throw fail('ALREADY_HAVE', 'You already have this free bot. Delete it first to deploy again.');
  } else if (user.coins < price) {
    throw fail('INSUFFICIENT', `You need ${price} coins to deploy this bot.`);
  }

  let debit = null;
  if (price >= 1) {
    try { debit = await wallet.debitCoins(user._id, price, 'Bot deploy', { template: String(tpl._id), templateName: tpl.name, serverName: nm }); }
    catch (e) { if (e.code === 'INSUFFICIENT') throw fail('INSUFFICIENT', `You need ${price} coins to deploy this bot.`); throw e; }
  }
  const server = await Server.create({
    user: user._id, kind: 'bot', template: tpl._id, templateName: tpl.name, planName: tpl.name, name: nm, status: 'pending', paidCoins: price,
    expiresAt: tpl.days > 0 ? periodSvc.addDays(new Date(), tpl.days) : null, periodDays: tpl.days || 0,
    resources: { memory: tpl.memory, disk: tpl.disk, cpu: tpl.cpu, databases: tpl.databases, backups: tpl.backups },
    deploymentStatus: 'In queue…', deployLog: ['› Order received'],
    events: [{ at: new Date(), type: 'order', text: price >= 1 ? `Paid ${price} coins` : 'Free bot' }]
  });
  queue.enqueue(() => bot.deploy({ serverId: server._id, userId: user._id, templateId: tpl._id, name: nm, debitReference: debit ? debit.transaction.reference : 'FREE', refundAmount: price }));
  return { server, tpl, price };
};
