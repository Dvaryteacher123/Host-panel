// Automatic payments (FimiPay): create a payment, confirm it, and deliver what was bought exactly once.
const PaymentOrder = require('../models/PaymentOrder');
const Plan = require('../models/Plan');
const Server = require('../models/Server');
const Transaction = require('../models/Transaction');
const wallet = require('./walletService');
const ptero = require('./pterodactylService');
const queue = require('./deployQueue');
const fimipay = require('./fimipayService');
const Setting = require('../models/Setting');
const Offer = require('../models/Offer');
const User = require('../models/User');
const BotAccess = require('../models/BotAccess');
const expiry = require('./expiryService');
const periodSvc = require('./periodService');

// ---------- markets (from the FimiPay docs: Tanzania, Kenya, Uganda, Nigeria, Ghana, Cameroon, South Africa) ----------
const COUNTRIES = {
  TZ: { name: 'Tanzania', flag: '🇹🇿', currency: 'TZS', code: '255', mobile: true, card: true },
  KE: { name: 'Kenya', flag: '🇰🇪', currency: 'KES', code: '254', mobile: true, card: true },
  UG: { name: 'Uganda', flag: '🇺🇬', currency: 'UGX', code: '256', mobile: true, card: true },
  NG: { name: 'Nigeria', flag: '🇳🇬', currency: 'NGN', code: '234', mobile: true, card: true },
  GH: { name: 'Ghana', flag: '🇬🇭', currency: 'GHS', code: '233', mobile: true, card: true },
  CM: { name: 'Cameroon', flag: '🇨🇲', currency: 'XAF', code: '237', mobile: true, card: true },
  ZA: { name: 'South Africa', flag: '🇿🇦', currency: 'ZAR', code: '27', mobile: false, card: true }
};

// Approximate "how many units of this currency equal 1 TZS". Override with FIMIPAY_RATES in .env and keep it up to date!
const DEFAULT_RATES = { TZS: 1, KES: 0.05, UGX: 1.4, NGN: 0.6, GHS: 0.0045, XAF: 0.23, ZAR: 0.007 };

const COUNTRIES_BY_CUR = {};
Object.keys(COUNTRIES).forEach((k) => { COUNTRIES_BY_CUR[COUNTRIES[k].currency] = true; });

// Prices are set by the admin (Admin -> Settings / Plans). .env values are only the fallback.
function parseRates(str, out) {
  String(str || '').split(',').forEach((pair) => {
    const [cur, val] = pair.split(':').map((x) => String(x || '').trim());
    const n = Number(val);
    if (cur && n > 0) out[cur.toUpperCase()] = n;
  });
  return out;
}
function economy(site) {
  const rates = parseRates(process.env.FIMIPAY_RATES, Object.assign({}, DEFAULT_RATES));
  parseRates(site && site.payRates, rates);
  rates.TZS = 1;
  const envCoin = Number(process.env.COIN_PRICE_TZS || 100);
  const coinPriceTZS = site && Number(site.coinPriceTZS) > 0 ? Number(site.coinPriceTZS) : (envCoin > 0 ? envCoin : 100);
  const coinPrices = {};
  const raw = (site && site.coinPrices) || {};
  Object.keys(raw).forEach((k) => { const n = Number(raw[k]); if (n > 0 && COUNTRIES_BY_CUR[k]) coinPrices[k] = n; });
  return { rates, coinPriceTZS, coinPrices };
}
exports.economy = economy;

function enabledCountries() {
  const list = String(process.env.FIMIPAY_COUNTRIES || Object.keys(COUNTRIES).join(',')).split(',').map((c) => c.trim().toUpperCase()).filter((c) => COUNTRIES[c]);
  return list.length ? list : ['TZ'];
}

// what the pages need to know (no secrets)
exports.publicConfig = (site) => ({
  enabled: fimipay.isConfigured(),
  testMode: fimipay.isTestKey(),
  coinPriceTZS: economy(site).coinPriceTZS,
  rates: economy(site).rates,
  coinPrices: economy(site).coinPrices,
  countries: enabledCountries().map((c) => Object.assign({ id: c }, COUNTRIES[c]))
});

// Amount to charge. A fixed price set by the admin for that currency wins; otherwise the TZS price is converted.
//  server: item = { coins, priceTZS, prices }   coins: item = { coins }
function priceFor(item, kind, countryId, eco) {
  const c = COUNTRIES[countryId];
  const cur = c.currency;
  if (kind === 'server') {
    const fixed = Number(item.prices && item.prices[cur]);
    if (cur !== 'TZS' && fixed > 0) return { amount: Math.max(1, Math.ceil(fixed)), currency: cur };
    const tzs = Number(item.priceTZS) > 0 ? Number(item.priceTZS) : item.coins * eco.coinPriceTZS;
    return { amount: Math.max(1, Math.ceil(tzs * (eco.rates[cur] || 1))), currency: cur };
  }
  if (cur !== 'TZS' && eco.coinPrices[cur] > 0) return { amount: Math.max(1, Math.ceil(item.coins * eco.coinPrices[cur])), currency: cur };
  return { amount: Math.max(1, Math.ceil(item.coins * eco.coinPriceTZS * (eco.rates[cur] || 1))), currency: cur };
}
exports.priceFor = priceFor;

class PayError extends Error {}

function cleanPhone(raw, countryId) {
  let d = String(raw || '').replace(/\D/g, '');
  const code = COUNTRIES[countryId].code;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = code + d.slice(1);
  if (d.length < 9 || d.length > 15) throw new PayError('Enter a valid phone number with country code, e.g. 255712345678.');
  return d;
}

const appUrl = () => String(process.env.APP_URL || '').replace(/\/+$/, '');

// ---------- create ----------
// opts: { user, kind: 'server'|'coins', plan, serverName, coins, country, method, phone }
exports.createPayment = async (opts) => {
  if (!fimipay.isConfigured()) throw new PayError('Online payment is not available yet. Please contact support.');
  const country = String(opts.country || 'TZ').toUpperCase();
  if (!enabledCountries().includes(country)) throw new PayError('This country is not available.');
  const c = COUNTRIES[country];
  const method = opts.method === 'card' ? 'card' : 'mobile';
  if (!c[method]) throw new PayError(method === 'mobile' ? 'Mobile money is not available in this country. Use a card.' : 'Card payments are not available in this country.');
  if (!appUrl()) throw new PayError('Online payment is not set up yet (APP_URL missing). Please contact support.');
  const phone = cleanPhone(opts.phone, country);

  const pending = await PaymentOrder.countDocuments({ user: opts.user._id, status: { $in: ['creating', 'pending'] }, createdAt: { $gt: new Date(Date.now() - 3600 * 1000) } });
  if (pending >= 5) throw new PayError('You have too many unfinished payments. Please wait a few minutes and try again.');

  let coins, item;
  if (opts.kind === 'coins') { coins = opts.coins; item = { coins }; }
  else if (opts.bot) { coins = opts.bot.coins; item = { coins: opts.bot.coins, priceTZS: opts.bot.priceTZS, prices: opts.bot.prices }; }
  else if (opts.offer) { coins = opts.offer.coins; item = { coins: opts.offer.coins, priceTZS: opts.offer.priceTZS, prices: opts.offer.prices }; }
  else if (opts.period) { coins = opts.period.coins; item = { coins: opts.period.coins, priceTZS: opts.period.priceTZS, prices: opts.period.prices }; }
  else { coins = opts.plan.coins; item = opts.plan; }
  const isPlan = opts.kind !== 'coins';
  const eco = economy(await Setting.getMain());
  const { amount, currency } = priceFor(item, isPlan ? 'server' : 'coins', country, eco);
  if (isPlan && !(Number(item.priceTZS) > 0) && !(Number(item.prices && item.prices[currency]) > 0) && !(item.coins > 0)) throw new PayError('This item cannot be paid with money. Use the coins button.');
  if (opts.offer) {
    const open = await PaymentOrder.countDocuments({ offer: opts.offer._id, status: { $in: ['creating', 'pending'] }, createdAt: { $gt: new Date(Date.now() - 10 * 60000) } });
    if (open) throw new PayError('You already have an unfinished payment for this offer. Finish it or wait a few minutes.');
  }

  const order = await PaymentOrder.create({
    user: opts.user._id, kind: opts.kind, plan: opts.plan ? opts.plan._id : null, offer: opts.offer ? opts.offer._id : null, planName: opts.plan ? opts.plan.name : (opts.bot ? opts.bot.title : ''), bot: opts.bot ? opts.bot._id : null, server: opts.server ? opts.server._id : null,
    period: opts.period ? opts.period.index : -1, periodDays: opts.offer ? (opts.offer.serverDays || 0) : (opts.period ? opts.period.days : 0), periodLabel: opts.period ? opts.period.label : '',
    serverName: opts.serverName || '', coins, country, currency, amount, method, phone, status: 'creating',
    environment: fimipay.isTestKey() ? 'test' : 'live'
  });

  const payload = {
    buyer_email: opts.user.email, buyer_name: opts.user.name, buyer_phone: phone,
    amount, currency, payment_method: method,
    redirect_url: appUrl() + '/dashboard/pay/' + order._id
  };
  if (fimipay.isTestKey() && process.env.FIMIPAY_TEST_OUTCOME) payload.test_outcome = process.env.FIMIPAY_TEST_OUTCOME; // pending | success | failed

  try {
    const data = await fimipay.createOrder(payload);
    const gw = /^https:\/\//i.test(String(data.payment_gateway_url || '')) ? data.payment_gateway_url : '';
    await PaymentOrder.updateOne({ _id: order._id }, { $set: {
      orderId: String(data.order_id), gatewayUrl: gw, status: 'pending', remoteStatus: String(data.payment_status || 'PENDING'),
      environment: data.environment || order.environment
    } });
    return PaymentOrder.findById(order._id);
  } catch (e) {
    console.error('[pay] create_order failed:', e.message);
    await PaymentOrder.updateOne({ _id: order._id }, { $set: { status: 'failed', error: String(e.message).slice(0, 300) } });
    throw new PayError('Could not start the payment. Please try again in a moment.');
  }
};
exports.PayError = PayError;

// ---------- confirm ----------
// Always asks FimiPay for the real status (never trusts a webhook body on its own).
async function sync(order) {
  if (!order || !order.orderId || !['pending', 'cancelled', 'failed'].includes(order.status)) return order;
  await PaymentOrder.updateOne({ _id: order._id }, { $set: { lastCheckAt: new Date() } });
  const data = await fimipay.orderStatus(order.orderId);
  const remote = String(data.payment_status || '').toUpperCase();
  const set = { remoteStatus: remote };
  if (data.transid) set.transId = String(data.transid);
  if (data.channel) set.channel = String(data.channel);

  if (remote === 'SUCCESS') {
    // safety: the paid amount must match what we asked for
    if ((data.currency && String(data.currency).toUpperCase() !== order.currency) || (data.amount != null && Number(data.amount) < order.amount)) {
      console.error('[pay] AMOUNT MISMATCH for', String(order._id), data.amount, data.currency, 'expected', order.amount, order.currency);
      await PaymentOrder.updateOne({ _id: order._id }, { $set: Object.assign(set, { note: 'Amount mismatch - check manually' }) });
      return PaymentOrder.findById(order._id);
    }
    const flipped = await PaymentOrder.findOneAndUpdate({ _id: order._id, status: { $in: ['pending', 'cancelled', 'failed'] } }, { $set: Object.assign(set, { status: 'paid', paidAt: new Date() }) });
    if (flipped) await fulfil(order._id);
  } else if (remote === 'FAILED' || remote === 'CANCELLED') {
    if (order.status === 'pending') set.status = remote === 'FAILED' ? 'failed' : 'cancelled';
    await PaymentOrder.updateOne({ _id: order._id }, { $set: set });
  } else {
    await PaymentOrder.updateOne({ _id: order._id }, { $set: set });
  }
  return PaymentOrder.findById(order._id);
}
exports.sync = sync;

// ---------- deliver ----------
async function fulfil(orderId) {
  // claim: only one worker delivers; a crashed claim becomes available again after 2 minutes
  const order = await PaymentOrder.findOneAndUpdate(
    { _id: orderId, status: 'paid', fulfilled: false, $or: [{ fulfillAt: null }, { fulfillAt: { $lt: new Date(Date.now() - 120000) } }] },
    { $set: { fulfillAt: new Date() } }, { new: true }
  );
  if (!order) return;
  try {
    const creditOnce = async (description) => {
      if (order.coins < 1) return;
      const done = await Transaction.findOne({ 'meta.paymentOrder': String(order._id) });
      if (!done) await wallet.creditCoins(order.user, order.coins, description, { paymentOrder: String(order._id), fimipayOrder: order.orderId });
    };

    if (order.kind === 'coins') {
      await creditOnce('Coins purchase (automatic payment)');
      await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: order.coins + ' coins added' } });
      return;
    }

    if (order.kind === 'renew') {
      const ok = await expiry.extend(order.server, order.periodDays, order._id);
      const stillThere = ok || await Server.exists({ _id: order.server, renewedBy: order._id });
      if (!stillThere) {
        await creditOnce('Server not found (credited as Coins)');
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Server missing: credited ' + order.coins + ' coins' } });
        return;
      }
      await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Renewed +' + order.periodDays + ' days' } });
      return;
    }

    if (order.kind === 'bot') {
      const existing = await BotAccess.findOne({ user: order.user, bot: order.bot });
      if (existing && String(existing.paymentOrder) !== String(order._id)) {
        await creditOnce('Bot already unlocked (credited as Coins)');
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Already owned: credited ' + order.coins + ' coins' } });
        return;
      }
      if (!existing) {
        try { await BotAccess.create({ user: order.user, bot: order.bot, via: 'money', paymentOrder: order._id }); }
        catch (e) { if (!(e && e.code === 11000)) throw e; }
      }
      await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Bot unlocked' } });
      return;
    }

    if (order.kind === 'adminplan') {
      const plan = order.plan ? await Plan.findById(order.plan) : null;
      const me = await User.findById(order.user);
      if (!me || !plan || !ptero.isConfigured() || me.pteroAdmin) {
        await creditOnce('Payment received (credited as Coins)');
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Admin Panel not activated: credited ' + order.coins + ' coins instead' } });
        return;
      }
      try {
        const acct = await ptero.ensureUser(me);
        await ptero.setRootAdmin(acct.id, true);
        const set = { pteroAdmin: true, pteroUserId: acct.id };
        if (acct.created) set.pteroManaged = true;
        await User.updateOne({ _id: me._id }, { $set: set });
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), panelPassword: acct.generatedPassword || '', note: 'Admin Panel unlocked' } });
      } catch (e) {
        console.error('[pay] admin panel activation failed', e.message);
        await creditOnce('Admin Panel activation failed (credited as Coins)');
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Activation failed: credited ' + order.coins + ' coins' } });
      }
      return;
    }

    // kind === 'server'
    let server = await Server.findOne({ paymentOrder: order._id });
    if (!server) {
      const plan = order.plan ? await Plan.findById(order.plan) : null;
      if (!plan || !ptero.isConfigured()) {
        await creditOnce('Payment received (credited as Coins)');
        await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), note: 'Hosting not available: credited ' + order.coins + ' coins instead' } });
        return;
      }
      server = await Server.create({
        user: order.user, plan: plan._id, planName: plan.name, name: order.serverName, status: 'pending', paymentOrder: order._id, paidCoins: order.coins,
        expiresAt: order.periodDays > 0 ? periodSvc.addDays(new Date(), order.periodDays) : null, periodDays: order.periodDays || 0,
        resources: { memory: plan.memory, disk: plan.disk, cpu: plan.cpu, databases: plan.databases, backups: plan.backups },
        deploymentStatus: 'Payment received. In queue…'
      });
      const { runProvision } = require('../routes/servers');
      queue.enqueue(() => runProvision({ serverId: server._id, userId: order.user, planId: plan._id, name: order.serverName, debitReference: 'PAID-' + order.orderId, refundAmount: order.coins }));
    }
    if (order.offer) await Offer.updateOne({ _id: order.offer, status: 'active' }, { $set: { status: 'used', usedAt: new Date(), usedWith: 'money', server: server._id } });
    await PaymentOrder.updateOne({ _id: order._id }, { $set: { fulfilled: true, fulfilledAt: new Date(), server: server._id, note: order.offer ? 'Server ordered (offer)' : 'Server ordered' } });
  } catch (e) {
    console.error('[pay] fulfil failed for', String(order._id), e.message);   // the reconcile loop retries it
  }
}
exports.fulfil = fulfil;

// ---------- background safety net ----------
// Catches payments whose webhook was missed, and finishes deliveries that crashed half-way.
exports.reconcile = async () => {
  try {
    const now = Date.now();
    const pending = await PaymentOrder.find({
      status: 'pending', orderId: { $ne: '' }, createdAt: { $gt: new Date(now - 24 * 3600 * 1000) },
      $or: [{ lastCheckAt: null }, { lastCheckAt: { $lt: new Date(now - 30000) } }]
    }).sort({ createdAt: 1 }).limit(30);
    for (const o of pending) { try { await sync(o); } catch (e) { console.error('[pay] reconcile sync failed', e.message); } }

    const stuck = await PaymentOrder.find({ status: 'paid', fulfilled: false, paidAt: { $lt: new Date(now - 60000) } }).limit(20);
    for (const o of stuck) await fulfil(o._id);

    await PaymentOrder.updateMany({ status: 'pending', createdAt: { $lt: new Date(now - 24 * 3600 * 1000) } }, { $set: { status: 'expired' } });
    await PaymentOrder.updateMany({ status: 'creating', createdAt: { $lt: new Date(now - 15 * 60000) } }, { $set: { status: 'failed', error: 'Never reached FimiPay' } });
  } catch (e) { console.error('[pay] reconcile failed', e.message); }
};
