require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const connectDB = require('./config/db');
const Setting = require('./models/Setting');
const { attachUser, requireAuth } = require('./middleware/auth');
const requireAdmin = require('./middleware/admin');
const Notification = require('./models/Notification');

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'CHANGE_THIS') {
  console.error('Set a strong SESSION_SECRET in .env');
  process.exit(1);
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');
// gzip every page (the pages are large inline HTML, this makes them ~5x smaller)
try { app.use(require('compression')({ threshold: 1024 })); } catch (e) { console.warn('compression not installed, skipping'); }

// view helpers + safe defaults (overridden per request by DB settings)
app.locals.site = { siteName: 'DVARY HOST', maintenance: false, registrationOpen: true, announcement: { active: false, text: '', type: 'info' }, paymentInfo: '', supportLink: '' };
app.locals.googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
app.locals.unreadChat = 0; app.locals.unreadCustomerChats = 0; app.locals.offerCount = 0;
app.locals.pay = require('./services/paymentService').publicConfig(null);
app.locals.periodsOf = require('./services/periodService').list;
app.locals.fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '-');
app.locals.fmtDateTime = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '-');
app.locals.fmtMB = (n) => (n >= 1024 ? (n / 1024).toFixed(n % 1024 ? 1 : 0) + ' GB' : n + ' MB');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
// FimiPay webhook: needs the RAW body (signature check), so it is registered before the body parsers and CSRF.
app.post('/webhook/fimipay', express.raw({ type: '*/*', limit: '200kb' }), (req, res) => require('./routes/payments').webhook(req, res));

app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(express.json());

// public REST API (key based, no cookies / sessions / CSRF)
app.use('/api/v1', require('./routes/api'));

app.use(session({
  name: 'dvary.sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: 'sessions', ttl: 60 * 60 * 24 * 7, touchAfter: 60 * 60 }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// site settings from MongoDB
app.use(async (req, res, next) => {
  try { res.locals.site = await Setting.getMain(); res.locals.pay = require('./services/paymentService').publicConfig(res.locals.site); } catch (e) { console.error('settings load failed', e.message); }
  next();
});

// flash messages + CSRF protection + Request Logger
app.use((req, res, next) => {
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  
  // multipart (ZIP upload) bodies are not parsed yet here, so also accept the token from the URL/header
  const sentToken = (req.body && req.body._csrf) || req.query._csrf || req.get('x-csrf-token');
  if (req.method === 'POST' && sentToken !== req.session.csrf) {
    console.warn('[CSRF] token mismatch on', req.method, req.path);
    return res.status(403).render('error', { code: 403, message: 'Session expired. Please go back, refresh and try again.' });
  }
  next();
});
app.use(attachUser);

// unread notification count for the bell (only for normal page loads, not background polling)
app.use(async (req, res, next) => {
  res.locals.unreadNotif = 0;
  try {
    if (req.user && req.method === 'GET' && (req.get('accept') || '').includes('text/html')) {
      res.locals.unreadNotif = await Notification.countDocuments({ createdAt: { $gt: req.user.notifSeenAt || req.user.createdAt } });
    }
  } catch (e) { console.error('notif count failed', e.message); }
  next();
});

// private offers from the admin: badge on "Buy Server" (normal page loads only)
app.use(async (req, res, next) => {
  res.locals.offerCount = 0;
  try {
    if (req.user && req.method === 'GET' && (req.get('accept') || '').includes('text/html')) {
      res.locals.offerCount = await require('./models/Offer').countDocuments({ user: req.user._id, status: 'active', $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
    }
  } catch (e) { console.error('offer count failed', e.message); }
  next();
});

// private chat: unread badges + admin "last seen" (only for normal page loads, not background polling)
app.use(async (req, res, next) => {
  res.locals.unreadChat = 0; res.locals.unreadCustomerChats = 0;
  try {
    if (req.user && req.method === 'GET' && (req.get('accept') || '').includes('text/html')) {
      const chat = require('./services/chatService');
      res.locals.unreadChat = await chat.unreadForUser(req.user._id);
      if (req.user.role === 'admin') {
        res.locals.unreadCustomerChats = await chat.unreadForAdmin(req.user._id);
        await require('./services/presence').touch(req.user._id);
      }
    }
  } catch (e) { console.error('chat badge failed', e.message); }
  next();
});

// maintenance mode: only admins (and the login page) get through
app.use((req, res, next) => {
  if (res.locals.site.maintenance && !(req.user && req.user.role === 'admin') && !['/login', '/logout'].includes(req.path)) {
    return res.status(503).render('error', { code: 503, message: 'We are under maintenance. Please come back soon.' });
  }
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/google'));
// public API documentation (anyone can read it)
app.get('/api-docs', async (req, res, next) => {
  try {
    const ApiPlan = require('./models/ApiPlan');
    const plan = await ApiPlan.getMain();
    res.render('api-docs', { base: `${req.protocol}://${req.get('host')}`, plan, priceText: require('./services/apiSubscription').priceText(plan), PERMS: ApiPlan.PERMS });
  } catch (e) { next(e); }
});

app.use('/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/dashboard', requireAuth, require('./routes/servers'));
app.use('/dashboard', requireAuth, require('./routes/coins'));
app.use('/dashboard', requireAuth, require('./routes/payments'));
app.use('/dashboard', requireAuth, require('./routes/offers'));
app.use('/dashboard', requireAuth, require('./routes/bots'));
app.use('/dashboard', requireAuth, require('./routes/deploy'));
app.use('/dashboard', requireAuth, require('./routes/apiKeys'));
app.use('/dashboard', requireAuth, require('./routes/renew'));
app.use('/dashboard', requireAuth, require('./routes/community'));
app.use('/dashboard', requireAuth, require('./routes/notifications'));
app.use('/dashboard', requireAuth, require('./routes/support'));
app.use('/dashboard', requireAuth, require('./routes/privateChat'));
app.use('/admin', requireAdmin, require('./routes/adminSupport'));
app.use('/admin', requireAdmin, require('./routes/adminChat'));
app.use('/admin', requireAdmin, require('./routes/adminTemplates'));
app.use('/admin', requireAdmin, require('./routes/adminApi'));
app.use('/admin', requireAdmin, require('./routes/adminGifts'));
app.use('/admin', requireAdmin, require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { code: 404, message: 'Page not found.' }));

// technical details go to the server log only with detailed error response tracking
app.use((err, req, res, next) => {
  console.error('[SERVER ERROR DETAILED]:', {
    message: err.message,
    stack: err.stack,
    response: err.response ? err.response.data : null
  });
  if (res.headersSent) return next(err);
  if (String(req.originalUrl).startsWith('/api/')) return res.status(err.status || 500).json({ ok: false, error: { code: 'SERVER_ERROR', message: 'Request could not be processed.' } });
  res.status(500).render('error', { code: 500, message: 'Something went wrong. Please try again.' });
});

connectDB().then(() => {
  const port = process.env.PORT || 3000;
  const srv = app.listen(port, () => console.log(`DVARY HOST running on port ${port}`));
  srv.keepAliveTimeout = 65000; srv.headersTimeout = 66000;
  // one-time upgrade: bots created before gift coins existed get a coin option of 1 coin
  require('./models/BotTemplate').updateMany({ offerCoins: { $exists: false } }, { $set: { offerCoins: 1 } }).catch((e) => console.error('[migrate] offerCoins', e.message));
  require('./routes/servers').recoverStuck();
  setInterval(() => require('./routes/servers').recoverStuck(), 10 * 60 * 1000).unref();
  // servers with a duration: free ones delete themselves, paid ones are suspended when time is over
  const expiry = require('./services/expiryService');
  expiry.run();
  setInterval(() => expiry.run(), 10 * 60 * 1000).unref();
  // automatic payments: catch missed webhooks + finish interrupted deliveries
  const paymentService = require('./services/paymentService');
  paymentService.reconcile();
  setInterval(() => paymentService.reconcile(), 60 * 1000).unref();
}).catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
