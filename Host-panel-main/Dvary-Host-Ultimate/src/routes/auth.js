const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Server = require('../models/Server');
const { wrap, guestOnly } = require('../middleware/auth');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// tiny in-memory login throttle: 10 failed attempts / 15 min / IP
const attempts = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(ip, rec);
  return rec.length >= 10;
}

router.get('/', wrap(async (req, res) => {
  const [plans, userCount, serverCount] = await Promise.all([
    Plan.find({ active: true, kind: { $ne: 'admin' } }).sort({ createdAt: 1 }).limit(6),
    User.countDocuments(), Server.countDocuments({ status: 'active' })
  ]);
  res.render('home', { plans, userCount, serverCount });
}));

const closed = (req, res) => {
  if (res.locals.site.registrationOpen === false) { req.flash('error', 'Registration is currently closed.'); res.redirect('/login'); return true; }
  return false;
};

router.get('/register', guestOnly, (req, res) => { if (closed(req, res)) return; res.render('register', { error: null, form: {} }); });
router.post('/register', guestOnly, wrap(async (req, res) => {
  if (closed(req, res)) return;
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const confirm = String(body.confirm || '');
  const form = { name, email };
  const fail = (error, code = 400) => res.status(code).render('register', { error, form });
  const isDev = process.env.NODE_ENV !== 'production';

  if (name.length < 2 || name.length > 60) return fail('Name must be 2-60 characters.');
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8 || password.length > 100) return fail('Password must be at least 8 characters.');
  if (password !== confirm) return fail('Passwords do not match.');

  try {
    // exact match on the normalised email only (a plain string, never an object)
    const taken = await User.findOne({ email: { $eq: email } }).select('_id').lean();
    if (taken) return fail('This email is already registered.');

    await User.create({ name, email, password: await bcrypt.hash(password, 12), role: 'user', coins: 0 });
  } catch (e) {
    console.error('[REGISTER ERROR]', { code: e.code, name: e.name, message: e.message, keyPattern: e.keyPattern, keyValue: e.keyValue });

    if (e.code === 11000) {
      const field = Object.keys(e.keyPattern || e.keyValue || {})[0];
      // only a real duplicate on the email field means "email already registered"
      if (field === 'email') return fail('This email is already registered.');
      return fail(
        'Registration failed because of a database index conflict' + (field ? ' on field "' + field + '"' : '') +
        '. Run: node scripts/fix-user-indexes.js' + (isDev ? ' (' + e.message + ')' : ''),
        500
      );
    }
    if (e.name === 'ValidationError') {
      return fail(Object.values(e.errors).map((x) => x.message).join(' '), 400);
    }
    return fail('Could not create the account: ' + (isDev ? e.message : 'database error, please try again.'), 500);
  }

  req.flash('success', 'Account created. Please log in.');
  res.redirect('/login');
}));

router.get('/login', guestOnly, (req, res) => res.render('login', { error: null, form: {} }));
router.post('/login', guestOnly, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const fail = (error, code = 400) => res.status(code).render('login', { error, form: { email } });
  if (throttled(req.ip)) return fail('Too many attempts. Try again later.', 429);

  const user = await User.findOne({ email });
  const ok = user && await bcrypt.compare(password, user.password);
  if (!ok) { attempts.get(req.ip).push(Date.now()); return fail('Invalid email or password.'); }
  if (user.banned) return fail('This account is suspended. Please contact support.', 403);

  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  const dest = user.role === 'admin' ? '/admin' : '/dashboard';
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = String(user._id);
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.session.save(() => res.redirect(dest));
  });
}));



router.post('/logout', (req, res) => {
  if (req.user && req.user.role === 'admin') require('./../services/presence').clear(req.user._id).catch(() => {});
  req.session.destroy(() => {
    res.clearCookie('dvary.sid');
    res.redirect('/');
  });
});

module.exports = router;
