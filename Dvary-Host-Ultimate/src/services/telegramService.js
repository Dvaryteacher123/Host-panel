// Telegram shop bot: customers press /start, pick a service (server, admin panel, ZIP) and pay automatically with FimiPay.
// The bot talks to Telegram through a webhook (POST /webhook/telegram) - no polling, so it works on Render.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const TgUser = require('../models/TgUser');
const Plan = require('../models/Plan');
const Zip = require('../models/Zip');
const ZipAccess = require('../models/ZipAccess');
const Server = require('../models/Server');
const Setting = require('../models/Setting');
const PaymentOrder = require('../models/PaymentOrder');
const pay = require('./paymentService');
const fimipay = require('./fimipayService');
const ptero = require('./pterodactylService');

const token = () => String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const appUrl = () => String(process.env.APP_URL || '').replace(/\/+$/, '');
exports.enabled = () => /^\d+:[\w-]{20,}$/.test(token());
const secret = () => String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim() || crypto.createHash('sha256').update('tg:' + token()).digest('hex').slice(0, 40);

// ---------------------------------------------------------------- Telegram API
async function api(method, body) {
  const res = await fetch('https://api.telegram.org/bot' + token() + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000)
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.ok) { const e = new Error('Telegram ' + method + ': ' + JSON.stringify(json || { status: res.status }).slice(0, 250)); e.tg = json; throw e; }
  return json.result;
}
exports.api = api;

// Registers the webhook (called on every start, so changing APP_URL / token just works).
exports.setup = async () => {
  if (!exports.enabled()) return;
  if (!/^https:\/\//i.test(appUrl())) { console.error('[tg] APP_URL must be a public https:// address so Telegram can reach the bot. Bot is OFF.'); return; }
  try {
    const me = await api('getMe');
    await api('setWebhook', { url: appUrl() + '/webhook/telegram', secret_token: secret(), allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
    await api('setMyCommands', { commands: [{ command: 'start', description: 'Start / Anza' }, { command: 'menu', description: 'Menu' }] }).catch(() => {});
    console.log('[tg] bot @' + me.username + ' is ready, webhook ' + appUrl() + '/webhook/telegram');
  } catch (e) { console.error('[tg] setup failed:', e.message); }
};

// ---------------------------------------------------------------- texts (Swahili / English)
const TX = {
  welcome: { sw: (n) => `👋 Karibu <b>${n}</b>!\n\nChagua huduma unayotaka hapa chini. Unalipia moja kwa moja (M-Pesa, Tigo Pesa, Airtel Money, Halotel au kadi) na huduma inakuja yenyewe baada ya malipo.`, en: (n) => `👋 Welcome <b>${n}</b>!\n\nPick a service below. You pay automatically (mobile money or card) and your order is delivered by itself after payment.` },
  bServer: { sw: '🖥️ Nunua Server', en: '🖥️ Buy Server' },
  bAdmin: { sw: '👑 Admin Panel', en: '👑 Admin Panel' },
  bZip: { sw: '📦 ZIP (Bure & VIP)', en: '📦 ZIPs (Free & VIP)' },
  bOrders: { sw: '📋 Huduma zangu', en: '📋 My services' },
  bWeb: { sw: '🌐 Akaunti ya website', en: '🌐 Website account' },
  bLang: { sw: '🌍 English', en: '🌍 Kiswahili' },
  bSupport: { sw: '🎧 Msaada', en: '🎧 Support' },
  bBack: { sw: '⬅️ Menu', en: '⬅️ Menu' },
  bCancel: { sw: '❌ Ghairi', en: '❌ Cancel' },
  bCheck: { sw: '🔄 Angalia malipo', en: '🔄 Check payment' },
  bPayNow: { sw: '💳 Fungua ukurasa wa malipo', en: '💳 Open payment page' },
  bMobile: { sw: '📱 Mobile money', en: '📱 Mobile money' },
  bCard: { sw: '💳 Kadi (Visa/Mastercard)', en: '💳 Card (Visa/Mastercard)' },
  bFree: { sw: '🆓 ZIP za Bure', en: '🆓 Free ZIPs' },
  bVip: { sw: '💎 ZIP za VIP (kununua)', en: '💎 VIP ZIPs (buy)' },
  bDownload: { sw: '⬇️ Pakua', en: '⬇️ Download' },
  unavailable: { sw: '⚠️ Malipo ya mtandaoni hayapatikani kwa sasa. Wasiliana na msaada.', en: '⚠️ Online payment is not available right now. Please contact support.' },
  noItems: { sw: 'Hakuna kitu kwa sasa. Rudi baadaye.', en: 'Nothing available right now. Please check back later.' },
  pickServer: { sw: '🖥️ <b>Chagua server</b>\n\n', en: '🖥️ <b>Pick a server</b>\n\n' },
  pickAdmin: { sw: '👑 <b>Admin Panel</b>\nUnakuwa admin kamili wa panel (unaweza kutengeneza users na server).\n\n', en: '👑 <b>Admin Panel</b>\nYou become a full admin of the panel (create users and servers).\n\n' },
  zipMenu: { sw: '📦 <b>ZIP Shop</b>\nChagua aina:', en: '📦 <b>ZIP Shop</b>\nChoose a type:' },
  freeTitle: { sw: '🆓 <b>ZIP za Bure</b>\nGusa ili kupata link:', en: '🆓 <b>Free ZIPs</b>\nTap to get the link:' },
  vipTitle: { sw: '💎 <b>ZIP za VIP</b>\nGusa ili kununua (au kupakua kama umeshanunua):', en: '💎 <b>VIP ZIPs</b>\nTap to buy (or download if you already own it):' },
  askEmail: { sw: '📧 Tuma <b>email yako</b> (utaitumia kuingia kwenye panel). Mfano: jina@gmail.com', en: '📧 Send your <b>email address</b> (you will use it to log in to the panel). Example: name@gmail.com' },
  badEmail: { sw: '⚠️ Email si sahihi. Tuma tena.', en: '⚠️ That email is not valid. Send it again.' },
  emailTaken: { sw: '⚠️ Email hii tayari imesajiliwa kwenye website. Tumia email nyingine.', en: '⚠️ This email is already registered on the website. Use another email.' },
  askName: { sw: '✏️ Tuma <b>jina la server yako</b> (herufi 3-60).', en: '✏️ Send a <b>name for your server</b> (3-60 characters).' },
  badName: { sw: '⚠️ Jina liwe herufi 3 hadi 60. Tuma tena.', en: '⚠️ The name must be 3-60 characters. Send it again.' },
  askMethod: { sw: '💰 Chagua njia ya kulipa:', en: '💰 Choose how to pay:' },
  askCountry: { sw: '🌍 Chagua nchi:', en: '🌍 Choose your country:' },
  askPhone: { sw: '📱 Tuma <b>namba ya simu</b> yenye code ya nchi, mfano <code>255712345678</code>.', en: '📱 Send your <b>phone number</b> with country code, e.g. <code>255712345678</code>.' },
  alreadyAdmin: { sw: '✅ Tayari wewe ni admin wa panel.', en: '✅ You already own an Admin Panel.' },
  hostingOff: { sw: '⚠️ Hosting haijawekwa bado. Wasiliana na msaada.', en: '⚠️ Hosting is not configured yet. Please contact support.' },
  cancelled: { sw: 'Imeghairiwa.', en: 'Cancelled.' },
  waitMobile: { sw: (amt) => `📱 <b>Angalia simu yako</b> na uthibitishe malipo ya <b>${amt}</b> (weka PIN yako).\n\nMalipo yakithibitishwa, huduma yako inakuja hapa moja kwa moja. ✅`, en: (amt) => `📱 <b>Check your phone</b> and approve the payment of <b>${amt}</b> (enter your PIN).\n\nOnce confirmed, your order arrives here automatically. ✅` },
  waitCard: { sw: (amt) => `💳 Lipa <b>${amt}</b> kwenye ukurasa wa malipo hapa chini. Ukimaliza, huduma inakuja hapa moja kwa moja. ✅`, en: (amt) => `💳 Pay <b>${amt}</b> on the payment page below. When done, your order arrives here automatically. ✅` },
  payFailed: { sw: '❌ Malipo hayakufanikiwa (hukukatwa pesa). Jaribu tena kutoka menu.', en: '❌ The payment did not go through (you were not charged). Try again from the menu.' },
  payCancelled: { sw: '❌ Malipo yalighairiwa. Jaribu tena kutoka menu.', en: '❌ The payment was cancelled. Try again from the menu.' },
  statusPending: { sw: '⏳ Bado tunasubiri malipo yathibitishwe…', en: '⏳ Still waiting for the payment to be confirmed…' },
  statusPaid: { sw: '✅ Malipo yamepokelewa. Tunaandaa oda yako…', en: '✅ Payment received. Preparing your order…' },
  statusDone: { sw: '✅ Oda yako imeshakamilika.', en: '✅ Your order is already delivered.' },
  zipLink: { sw: (t) => `📦 <b>${t}</b>\nLink yako ya kupakua:`, en: (t) => `📦 <b>${t}</b>\nYour download link:` },
  zipPaid: { sw: (t) => `✅ Malipo yamepokelewa!\n\n📦 <b>${t}</b>\nLink yako ya kupakua:`, en: (t) => `✅ Payment received!\n\n📦 <b>${t}</b>\nYour download link:` },
  serverBuilding: { sw: '⏳ Server yako inatengenezwa… utapata ujumbe hapa ikiwa tayari (kama dakika 1-2).', en: '⏳ Your server is being created… you will get a message here when it is ready (about 1-2 minutes).' },
  noOrders: { sw: 'Bado huna huduma. Chagua kutoka menu.', en: 'You have no services yet. Pick one from the menu.' },
  webInfo: { sw: (url, email, pw) => `🌐 <b>Akaunti ya website</b>\n\nLink: ${url}\nEmail: <code>${email}</code>\nPassword mpya: <code>${pw}</code>\n\n⚠️ Futa ujumbe huu baada ya kuhifadhi password.`, en: (url, email, pw) => `🌐 <b>Website account</b>\n\nLink: ${url}\nEmail: <code>${email}</code>\nNew password: <code>${pw}</code>\n\n⚠️ Delete this message after saving the password.` },
  unknown: { sw: 'Gusa /start kuona menu.', en: 'Send /start to see the menu.' },
  banned: { sw: '⛔ Akaunti hii imezuiwa.', en: '⛔ This account is blocked.' }
};
const t = (lang, key, ...a) => { const v = TX[key][lang] || TX[key].en; return typeof v === 'function' ? v(...a) : v; };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtMB = (n) => (n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' GB' : n + ' MB');
const money = (n, cur) => Number(n).toLocaleString('en-US') + ' ' + (cur || 'TZS');
const isPlaceholder = (email) => /@telegram\.local$/i.test(email || '');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

const btn = (text, data) => ({ text, callback_data: data });
const urlBtn = (text, url) => ({ text, url });
const markup = (rows) => ({ inline_keyboard: rows });

async function send(chatId, text, kb) {
  return api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb || undefined });
}
// edit the menu message in place when we can, otherwise send a new one
async function show(ctx, text, kb) {
  if (ctx.msgId) {
    try { return await api('editMessageText', { chat_id: ctx.chatId, message_id: ctx.msgId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: kb || { inline_keyboard: [] } }); }
    catch (e) { if (!/not modified/i.test(e.message)) { /* fall through to a new message */ } else return null; }
  }
  return send(ctx.chatId, text, kb);
}

// ---------------------------------------------------------------- accounts
async function ensureAccount(from, chatId) {
  const tgId = String(from.id);
  let tgu = await TgUser.findOne({ tgId });
  if (tgu) {
    if (from.username && tgu.username !== from.username) { tgu.username = from.username; await tgu.save(); }
    return tgu;
  }
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim().slice(0, 60) || ('Telegram ' + tgId);
  const user = await User.create({ name, email: 'tg' + tgId + '@telegram.local', password: await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10), role: 'user', coins: 0 });
  try { tgu = await TgUser.create({ tgId, user: user._id, username: from.username || '', lang: 'sw' }); }
  catch (e) { if (e.code !== 11000) throw e; await User.deleteOne({ _id: user._id }); tgu = await TgUser.findOne({ tgId }); }
  return tgu;
}

async function mainMenu(ctx, greet) {
  const lang = ctx.lang;
  const site = await Setting.getMain();
  const rows = [
    [btn(t(lang, 'bServer'), 'sv')], [btn(t(lang, 'bAdmin'), 'ap')], [btn(t(lang, 'bZip'), 'zp')],
    [btn(t(lang, 'bOrders'), 'my'), btn(t(lang, 'bWeb'), 'web')],
    [btn(t(lang, 'bLang'), 'lang')]
  ];
  if (site.supportLink && /^https?:\/\//i.test(site.supportLink)) rows.push([urlBtn(t(lang, 'bSupport'), site.supportLink)]);
  const text = greet ? t(lang, 'welcome', esc(ctx.user.name)) : '🏠 <b>Menu</b>';
  return show(ctx, text, markup(rows));
}

// ---------------------------------------------------------------- lists
async function listServers(ctx) {
  const lang = ctx.lang; const eco = pay.economy(await Setting.getMain());
  const plans = await Plan.find({ active: true, kind: { $ne: 'admin' } }).sort({ coins: 1 }).limit(20).lean();
  if (!plans.length) return show(ctx, t(lang, 'noItems'), markup([[btn(t(lang, 'bBack'), 'm')]]));
  let text = t(lang, 'pickServer'); const rows = [];
  plans.forEach((p) => {
    const price = pay.priceFor(p, 'server', 'TZ', eco).amount;
    text += `<b>${esc(p.name)}</b> — ${money(price)}\n   💾 ${fmtMB(p.memory)} RAM · 💿 ${fmtMB(p.disk)} · ⚙️ ${p.cpu ? p.cpu + '%' : '∞'} CPU${p.description ? '\n   ' + esc(p.description) : ''}\n\n`;
    rows.push([btn(`${p.name} · ${money(price)}`, 'p:s:' + p._id)]);
  });
  rows.push([btn(t(lang, 'bBack'), 'm')]);
  return show(ctx, text, markup(rows));
}

async function listAdminPlans(ctx) {
  const lang = ctx.lang; const eco = pay.economy(await Setting.getMain());
  const plans = await Plan.find({ active: true, kind: 'admin' }).sort({ coins: 1 }).limit(20).lean();
  if (!plans.length) return show(ctx, t(lang, 'noItems'), markup([[btn(t(lang, 'bBack'), 'm')]]));
  let text = t(lang, 'pickAdmin'); const rows = [];
  plans.forEach((p) => {
    const price = pay.priceFor(p, 'server', 'TZ', eco).amount;
    text += `<b>👑 ${esc(p.name)}</b> — ${money(price)}${p.description ? '\n   ' + esc(p.description) : ''}\n\n`;
    rows.push([btn(`👑 ${p.name} · ${money(price)}`, 'p:a:' + p._id)]);
  });
  rows.push([btn(t(lang, 'bBack'), 'm')]);
  return show(ctx, text, markup(rows));
}

async function zipMenu(ctx) {
  const lang = ctx.lang;
  return show(ctx, t(lang, 'zipMenu'), markup([[btn(t(lang, 'bFree'), 'zf')], [btn(t(lang, 'bVip'), 'zv')], [btn(t(lang, 'bBack'), 'm')]]));
}

async function listZips(ctx, type) {
  const lang = ctx.lang; const eco = pay.economy(await Setting.getMain());
  const zips = await Zip.find({ active: true, type }).sort({ createdAt: -1 }).limit(30).lean();
  const back = markup([[btn('⬅️', 'zp')]]);
  if (!zips.length) return show(ctx, t(lang, 'noItems'), back);
  const owned = type === 'vip' ? new Set((await ZipAccess.find({ user: ctx.user._id }).select('zip').lean()).map((a) => String(a.zip))) : new Set();
  let text = t(lang, type === 'vip' ? 'vipTitle' : 'freeTitle') + '\n\n'; const rows = [];
  zips.forEach((z) => {
    const price = type === 'vip' ? pay.priceFor(z, 'server', 'TZ', eco).amount : 0;
    const have = owned.has(String(z._id));
    text += `${type === 'vip' ? (have ? '✅' : '💎') : '🆓'} <b>${esc(z.title)}</b>${type === 'vip' && !have ? ' — ' + money(price) : ''}${z.description ? '\n   ' + esc(z.description) : ''}\n\n`;
    rows.push([btn(`${have ? '⬇️' : (type === 'vip' ? '💎' : '🆓')} ${z.title}${type === 'vip' && !have ? ' · ' + money(price) : ''}`.slice(0, 60), 'z:' + z._id)]);
  });
  rows.push([btn('⬅️', 'zp')]);
  return show(ctx, text, markup(rows));
}

async function openZip(ctx, zipId) {
  const lang = ctx.lang;
  const z = await Zip.findOne({ _id: zipId, active: true }).lean();
  if (!z) return show(ctx, t(lang, 'noItems'), markup([[btn('⬅️', 'zp')]]));
  if (z.type === 'free' || await ZipAccess.exists({ user: ctx.user._id, zip: z._id })) {
    await Zip.updateOne({ _id: z._id }, { $inc: { downloads: 1 } });
    return send(ctx.chatId, t(lang, 'zipLink', esc(z.title)), markup([[urlBtn(t(lang, 'bDownload'), z.url)], [btn('⬅️', 'zp')]]));
  }
  return beginPurchase(ctx, 'zip', String(z._id));
}

async function myServices(ctx) {
  const lang = ctx.lang;
  const [servers, access, me] = await Promise.all([
    Server.find({ user: ctx.user._id }).sort({ createdAt: -1 }).limit(15).lean(),
    ZipAccess.find({ user: ctx.user._id }).populate('zip').sort({ createdAt: -1 }).limit(20).lean(),
    User.findById(ctx.user._id).lean()
  ]);
  const site = await Setting.getMain();
  const panel = String(site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, '');
  const rows = []; let text = '📋 <b>' + t(lang, 'bOrders').replace(/^📋 /, '') + '</b>\n\n';
  if (!servers.length && !access.length && !me.pteroAdmin) return show(ctx, t(lang, 'noOrders'), markup([[btn(t(lang, 'bBack'), 'm')]]));
  if (me.pteroAdmin) text += `👑 Admin Panel${panel ? ': ' + esc(panel + '/admin') : ''}\n\n`;
  servers.forEach((s) => { text += `🖥️ <b>${esc(s.name)}</b> — ${esc(s.planName)} — ${esc(s.status)}${s.panelUrl ? '' : ''}\n`; });
  if (servers.length && panel) text += `\n🔗 Panel: ${esc(panel)}\n`;
  access.filter((a) => a.zip).forEach((a) => rows.push([btn('⬇️ ' + a.zip.title.slice(0, 50), 'z:' + a.zip._id)]));
  rows.push([btn(t(lang, 'bBack'), 'm')]);
  return show(ctx, text, markup(rows));
}

// ---------------------------------------------------------------- purchase flow
// state = { step, kind: 'server'|'adminpanel'|'zip', item, name, method, country }
async function setState(ctx, state) { await TgUser.updateOne({ _id: ctx.tgu._id }, { $set: { state } }); ctx.tgu.state = state; }
async function clearState(ctx) { await setState(ctx, null); }

async function beginPurchase(ctx, kind, itemId) {
  const lang = ctx.lang;
  if (!fimipay.isConfigured() || !appUrl()) return show(ctx, t(lang, 'unavailable'), markup([[btn(t(lang, 'bBack'), 'm')]]));
  if (kind !== 'zip') {
    if (!ptero.isConfigured()) return show(ctx, t(lang, 'hostingOff'), markup([[btn(t(lang, 'bBack'), 'm')]]));
    const plan = await Plan.findOne({ _id: itemId, active: true, kind: kind === 'adminpanel' ? 'admin' : { $ne: 'admin' } }).lean();
    if (!plan) return show(ctx, t(lang, 'noItems'), markup([[btn(t(lang, 'bBack'), 'm')]]));
    if (kind === 'adminpanel') {
      const me = await User.findById(ctx.user._id).lean();
      if (me.pteroAdmin) return show(ctx, t(lang, 'alreadyAdmin'), markup([[btn(t(lang, 'bBack'), 'm')]]));
    }
  }
  await setState(ctx, { step: 'start', kind, item: String(itemId) });
  return advance(ctx);
}

// decides what to ask next, based on what the order still misses
async function advance(ctx, input) {
  const lang = ctx.lang; const st = ctx.tgu.state;
  if (!st) return mainMenu(ctx, false);
  const cancelRow = [btn(t(lang, 'bCancel'), 'x')];
  const me = await User.findById(ctx.user._id).lean();

  if (st.kind !== 'zip' && isPlaceholder(me.email) && !me.pteroUserId) {
    await setState(ctx, Object.assign({}, st, { step: 'email' }));
    return send(ctx.chatId, t(lang, 'askEmail'), markup([cancelRow]));
  }
  if (st.kind === 'server' && !st.name) {
    await setState(ctx, Object.assign({}, st, { step: 'name' }));
    return send(ctx.chatId, t(lang, 'askName'), markup([cancelRow]));
  }
  if (!st.method) {
    await setState(ctx, Object.assign({}, st, { step: 'method' }));
    return send(ctx.chatId, t(lang, 'askMethod'), markup([[btn(t(lang, 'bMobile'), 'pm:mobile'), btn(t(lang, 'bCard'), 'pm:card')], cancelRow]));
  }
  if (!st.country) {
    const cfg = pay.publicConfig(null).countries.filter((c) => c[st.method]);
    if (cfg.length === 1) { Object.assign(st, { country: cfg[0].id }); await setState(ctx, st); return advance(ctx); }
    await setState(ctx, Object.assign({}, st, { step: 'country' }));
    const rows = cfg.map((c) => [btn(`${c.flag} ${c.name} (${c.currency})`, 'pc:' + c.id)]); rows.push(cancelRow);
    return send(ctx.chatId, t(lang, 'askCountry'), markup(rows));
  }
  if (!st.phone) {
    await setState(ctx, Object.assign({}, st, { step: 'phone' }));
    const rows = [];
    if (ctx.tgu.lastPhone) rows.push([btn('📱 ' + ctx.tgu.lastPhone, 'ph:last')]);
    rows.push(cancelRow);
    return send(ctx.chatId, t(lang, 'askPhone'), markup(rows));
  }
  return finishPurchase(ctx);
}

async function finishPurchase(ctx) {
  const lang = ctx.lang; const st = ctx.tgu.state;
  const user = await User.findById(ctx.user._id);
  const opts = { user, kind: st.kind, country: st.country, method: st.method, phone: st.phone, tgChat: ctx.chatId, serverName: st.name || '' };
  if (st.kind === 'zip') opts.zip = await Zip.findOne({ _id: st.item, active: true });
  else opts.plan = await Plan.findOne({ _id: st.item, active: true, kind: st.kind === 'adminpanel' ? 'admin' : { $ne: 'admin' } });
  if ((st.kind === 'zip' && !opts.zip) || (st.kind !== 'zip' && !opts.plan)) { await clearState(ctx); return send(ctx.chatId, t(lang, 'noItems'), markup([[btn(t(lang, 'bBack'), 'm')]])); }
  await TgUser.updateOne({ _id: ctx.tgu._id }, { $set: { lastPhone: st.phone } });
  await clearState(ctx);
  try {
    const order = await pay.createPayment(opts);
    const amt = money(order.amount, order.currency);
    const rows = [];
    if (order.gatewayUrl) rows.push([urlBtn(t(lang, 'bPayNow'), order.gatewayUrl)]);
    rows.push([btn(t(lang, 'bCheck'), 'chk:' + order._id)], [btn(t(lang, 'bBack'), 'm')]);
    return send(ctx.chatId, order.gatewayUrl ? t(lang, 'waitCard', amt) : t(lang, 'waitMobile', amt), markup(rows));
  } catch (e) {
    if (e instanceof pay.PayError) return send(ctx.chatId, '⚠️ ' + esc(e.message), markup([[btn(t(lang, 'bBack'), 'm')]]));
    throw e;
  }
}

async function checkPayment(ctx, id) {
  const lang = ctx.lang;
  let order = await PaymentOrder.findOne({ _id: id, user: ctx.user._id });
  if (!order) return null;
  try { order = await pay.sync(order); } catch (e) { console.error('[tg] check sync failed', e.message); }
  if (order.status === 'paid' && !order.fulfilled) { await pay.fulfil(order._id); order = await PaymentOrder.findById(order._id); }
  const key = order.fulfilled ? 'statusDone' : (order.status === 'paid' ? 'statusPaid' : (order.status === 'pending' || order.status === 'creating' ? 'statusPending' : (order.status === 'cancelled' ? 'payCancelled' : 'payFailed')));
  return send(ctx.chatId, t(lang, key), markup([[btn(t(lang, 'bBack'), 'm')]]));
}

async function webAccount(ctx) {
  const lang = ctx.lang;
  const pw = crypto.randomBytes(9).toString('base64url');
  const me = await User.findById(ctx.user._id);
  me.password = await bcrypt.hash(pw, 12); await me.save();
  const url = appUrl() ? appUrl() + '/login' : '';
  return send(ctx.chatId, t(lang, 'webInfo', esc(url), esc(me.email), esc(pw)), markup([[btn(t(lang, 'bBack'), 'm')]]));
}

// ---------------------------------------------------------------- update router
const seen = []; // last update ids, Telegram may retry a webhook
async function handleUpdate(u) {
  if (u.update_id != null) { if (seen.includes(u.update_id)) return; seen.push(u.update_id); if (seen.length > 300) seen.shift(); }
  const cq = u.callback_query; const msg = u.message;
  const from = cq ? cq.from : (msg && msg.from); const chat = cq ? (cq.message && cq.message.chat) : (msg && msg.chat);
  if (!from || !chat || chat.type !== 'private' || from.is_bot) return;

  const tgu = await ensureAccount(from, chat.id);
  const user = await User.findById(tgu.user).lean();
  const ctx = { chatId: String(chat.id), msgId: cq && cq.message ? cq.message.message_id : null, tgu, user, lang: tgu.lang };
  if (!user || user.banned) { if (cq) await api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {}); return send(ctx.chatId, t(ctx.lang, 'banned')); }

  if (cq) {
    api('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    return handleCallback(ctx, String(cq.data || ''));
  }
  const text = String(msg.text || '').trim();
  if (/^\/(start|menu)(@\w+)?(\s|$)/i.test(text)) { await clearState(ctx); return mainMenu(Object.assign({}, ctx, { msgId: null }), /^\/start/i.test(text)); }
  const st = tgu.state;
  if (!st || !text) return send(ctx.chatId, t(ctx.lang, 'unknown'), markup([[btn(t(ctx.lang, 'bBack'), 'm')]]));
  return handleInput(ctx, st, text);
}

async function handleInput(ctx, st, text) {
  const lang = ctx.lang;
  if (st.step === 'email') {
    const email = text.toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 120) return send(ctx.chatId, t(lang, 'badEmail'));
    const taken = await User.findOne({ email: { $eq: email }, _id: { $ne: ctx.user._id } }).select('_id').lean();
    if (taken) return send(ctx.chatId, t(lang, 'emailTaken'));
    await User.updateOne({ _id: ctx.user._id }, { $set: { email } });
    return advance(ctx);
  }
  if (st.step === 'name') {
    if (text.length < 3 || text.length > 60) return send(ctx.chatId, t(lang, 'badName'));
    await setState(ctx, Object.assign({}, st, { name: text })); return advance(ctx);
  }
  if (st.step === 'phone') {
    await setState(ctx, Object.assign({}, st, { phone: text.slice(0, 20) })); return advance(ctx);
  }
  return send(ctx.chatId, t(lang, 'unknown'), markup([[btn(t(lang, 'bBack'), 'm')]]));
}

async function handleCallback(ctx, d) {
  const lang = ctx.lang; const st = ctx.tgu.state;
  if (d === 'm') { await clearState(ctx); return mainMenu(ctx, false); }
  if (d === 'x') { await clearState(ctx); await show(ctx, t(lang, 'cancelled'), markup([[btn(t(lang, 'bBack'), 'm')]])); return; }
  if (d === 'lang') { const nl = lang === 'sw' ? 'en' : 'sw'; await TgUser.updateOne({ _id: ctx.tgu._id }, { $set: { lang: nl } }); ctx.lang = nl; return mainMenu(ctx, false); }
  if (d === 'sv') return listServers(ctx);
  if (d === 'ap') return listAdminPlans(ctx);
  if (d === 'zp') return zipMenu(ctx);
  if (d === 'zf') return listZips(ctx, 'free');
  if (d === 'zv') return listZips(ctx, 'vip');
  if (d === 'my') return myServices(ctx);
  if (d === 'web') return webAccount(ctx);
  if (d.startsWith('z:')) return openZip(ctx, d.slice(2));
  if (/^p:[sa]:[a-f0-9]{24}$/.test(d)) return beginPurchase(ctx, d[2] === 's' ? 'server' : 'adminpanel', d.slice(4));
  if (/^chk:[a-f0-9]{24}$/.test(d)) return checkPayment(ctx, d.slice(4));
  if (st && d.startsWith('pm:') && ['mobile', 'card'].includes(d.slice(3))) { await setState(ctx, Object.assign({}, st, { method: d.slice(3), country: '' })); return advance(ctx); }
  if (st && /^pc:[A-Z]{2}$/.test(d)) { await setState(ctx, Object.assign({}, st, { country: d.slice(3) })); return advance(ctx); }
  if (st && d === 'ph:last' && ctx.tgu.lastPhone) { await setState(ctx, Object.assign({}, st, { phone: ctx.tgu.lastPhone })); return advance(ctx); }
}

// Express handler (mounted in server.js before the body parsers / CSRF)
exports.webhook = (req, res) => {
  if (!exports.enabled()) return res.status(503).send('Not configured');
  const given = String(req.get('x-telegram-bot-api-secret-token') || '');
  const a = Buffer.from(given); const b = Buffer.from(secret());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Invalid secret');
  res.status(200).json({ ok: true });                       // answer fast, work in the background
  handleUpdate(req.body || {}).catch((e) => console.error('[tg] update failed:', e && e.message));
};

// ---------------------------------------------------------------- delivery notifications (called by payment / provisioning code)
async function langOf(chatId) { const x = await TgUser.findOne({ tgId: String(chatId) }).select('lang').lean(); return (x && x.lang) || 'sw'; }
const home = (lang) => markup([[btn(t(lang, 'bBack'), 'm')]]);

exports.notifyZip = async (order, zip) => {
  const lang = await langOf(order.tgChat);
  await send(order.tgChat, t(lang, 'zipPaid', esc(zip.title)), markup([[urlBtn(t(lang, 'bDownload'), zip.url)], [btn(t(lang, 'bBack'), 'm')]]));
};

exports.notifyAdminPanel = async (order, user, password) => {
  const lang = await langOf(order.tgChat);
  const site = await Setting.getMain();
  const url = String(site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, '');
  const pw = password ? (lang === 'sw' ? `Password: <code>${esc(password)}</code>\n(Imeonyeshwa mara moja tu, ihifadhi sasa)` : `Password: <code>${esc(password)}</code>\n(shown only once, save it now)`)
    : (lang === 'sw' ? 'Tumia password yako ya panel ya sasa (ukisahau, tumia "Forgot password" kwenye panel).' : 'Use your existing panel password (forgot it? use "Forgot password" on the panel).');
  const text = (lang === 'sw' ? '✅ <b>Malipo yamepokelewa — sasa wewe ni Admin wa Panel!</b> 👑\n\n' : '✅ <b>Payment received — you are now a Panel Admin!</b> 👑\n\n')
    + `🔗 ${esc(url ? url + '/admin' : '')}\nEmail: <code>${esc(user.email)}</code>\n${pw}`;
  await send(order.tgChat, text, home(lang));
};

exports.notifyAdminPanelFallback = async (order) => {
  const lang = await langOf(order.tgChat);
  await send(order.tgChat, lang === 'sw' ? `⚠️ Tumeshindwa kuwasha Admin Panel. Malipo yako yamegeuzwa kuwa <b>${order.coins} coins</b> kwenye akaunti yako ya website. Wasiliana na msaada.` : `⚠️ We could not activate the Admin Panel. Your payment was credited as <b>${order.coins} coins</b> on your website account. Please contact support.`, home(lang));
};

exports.notifyServerReady = async (server, user, password) => {
  const lang = await langOf(server.tgChat);
  const site = await Setting.getMain();
  const url = String(site.panelUrl || ptero.baseUrl() || '').replace(/\/+$/, '');
  const pw = password ? `Password: <code>${esc(password)}</code>\n${lang === 'sw' ? '(Imeonyeshwa mara moja tu, ihifadhi sasa)' : '(shown only once, save it now)'}`
    : (lang === 'sw' ? 'Tumia password yako ya panel ya sasa.' : 'Use your existing panel password.');
  const text = (lang === 'sw' ? '✅ <b>Server yako iko tayari!</b> 🚀\n\n' : '✅ <b>Your server is ready!</b> 🚀\n\n')
    + `🖥️ <b>${esc(server.name)}</b> (${esc(server.planName)})\n🔗 ${esc(url)}\nEmail: <code>${esc(user.email)}</code>\n${pw}\n\n`
    + (lang === 'sw' ? 'Inamaliza ku-install kwa kama dakika 1.' : 'It finishes installing in about a minute.');
  await send(server.tgChat, text, home(lang));
  if (password) await Server.updateOne({ _id: server._id }, { $set: { panelPassword: '' } });   // delivered, do not keep the secret
};

exports.notifyServerFailed = async (server, coins) => {
  const lang = await langOf(server.tgChat);
  await send(server.tgChat, lang === 'sw' ? `❌ Tumeshindwa kutengeneza server yako. Malipo yamerudishwa kama <b>${coins} coins</b> kwenye akaunti yako ya website (bonyeza "Akaunti ya website" kwenye menu kuingia).` : `❌ We could not create your server. Your payment was returned as <b>${coins} coins</b> on your website account (tap "Website account" in the menu to log in).`, home(lang));
};

exports.notifyPaymentFailed = async (order, status) => {
  const lang = await langOf(order.tgChat);
  await send(order.tgChat, t(lang, status === 'cancelled' ? 'payCancelled' : 'payFailed'), home(lang));
};
