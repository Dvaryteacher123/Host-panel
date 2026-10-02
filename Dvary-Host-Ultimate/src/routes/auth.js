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
    Plan.find({ active: true, kind: { $ne: 'admin' } }).sort({ coins: 1 }).limit(6),
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
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const confirm = String(req.body.confirm || '');
  const form = { name, email };
  const fail = (error) => res.status(400).render('register', { error, form });

  if (name.length < 2 || name.length > 60) return fail('Name must be 2-60 characters.');
  if (!EMAIL_RE.test(email)) return fail('Enter a valid email address.');
  if (password.length < 8 || password.length > 100) return fail('Password must be at least 8 characters.');
  if (password !== confirm) return fail('Passwords do not match.');
  if (await User.exists({ email })) return fail('This email is already registered.');

  try {
    await User.create({ name, email, password: await bcrypt.hash(password, 12), role: 'user', coins: 0 });
  } catch (e) {
    if (e.code === 11000) return fail('This email is already registered.');
    throw e;
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
  req.session.destroy(() => {
    res.clearCookie('dvary.sid');
    res.redirect('/');
  });
});

module.exports = router;
