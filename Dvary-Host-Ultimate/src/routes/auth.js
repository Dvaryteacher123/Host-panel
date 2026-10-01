const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Plan = require('../models/Plan');
const Server = require('../models/Server');
const { wrap, guestOnly } = require('../middleware/auth');
const github = require('../services/githubService');

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
    Plan.find({ active: true }).sort({ coins: 1 }).limit(6),
    User.countDocuments(), Server.countDocuments({ status: 'active' })
  ]);
  res.render('home', { plans, userCount, serverCount });
}));

const closed = (req, res) => {
  if (res.locals.site.registrationOpen === false) { res.status(400).render('login', { error: 'Registration is currently closed.', form: {} }); return true; }
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
  res.status(200).render('login', { error: null, form: { email }, success: 'Account created. Please log in.' });
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



// ---------- GitHub OAuth ----------
router.get('/auth/github', (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET || !process.env.GITHUB_CALLBACK_URL) {
    return res.status(500).render('login', { error: 'GitHub sign-in is not configured yet.', form: {} });
  }
  const state = crypto.randomBytes(24).toString('hex');
  req.session.githubOAuthState = state;
  req.session.githubLinkUserId = req.user ? String(req.user._id) : '';
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope: 'read:user user:email repo',
    state
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

router.get('/auth/github/callback', wrap(async (req, res) => {
  const state = String(req.query.state || '');
  const expected = String(req.session.githubOAuthState || '');
  delete req.session.githubOAuthState;
  const linkUserId = String(req.session.githubLinkUserId || '');
  delete req.session.githubLinkUserId;
  if (!state || !expected || state !== expected) return res.status(403).render('error', { code: 403, message: 'GitHub sign-in session expired. Please try again.' });
  
  const code = String(req.query.code || '');
  if (!code) { 
    return res.status(400).render('login', { error: 'GitHub did not return an authorization code.', form: {} }); 
  }

  let token, ghUser, emails;
  try {
    token = await github.exchangeCode(code);
    ghUser = await github.getUser(token);
    emails = await github.getEmails(token);
  } catch (e) {
    return res.status(400).render('login', { error: 'Failed to communicate with GitHub: ' + e.message, form: {} });
  }

  const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified);
  const email = String(primary?.email || '').trim().toLowerCase();
  if (!email) { 
    return res.status(400).render('login', { error: 'Your GitHub account does not have a verified email address.', form: {} }); 
  }

  let user = null;
  const githubOwner = await User.findOne({ githubId: String(ghUser.id) });
  if (githubOwner && (!linkUserId || String(githubOwner._id) !== linkUserId)) {
    return res.status(400).render('login', { error: 'This GitHub account is already connected to another DVARY account.', form: {} });
  }
  if (linkUserId && req.user && String(req.user._id) === linkUserId) {
    user = req.user;
  } else {
    user = githubOwner || await User.findOne({ email });
  }
  if (!user) {
    user = await User.create({
      name: String(ghUser.name || ghUser.login || 'GitHub User').slice(0, 60),
      email,
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12),
      role: 'user', coins: 0
    });
  }
  if (user.banned) return res.status(403).render('login', { error: 'This account is suspended. Please contact support.', form: { email } });

  user.githubId = String(ghUser.id);
  user.githubLogin = String(ghUser.login || '');
  user.githubToken = github.encryptToken(token);
  user.lastLoginAt = new Date();
  if (!user.name || user.name === 'GitHub User') user.name = String(ghUser.name || ghUser.login || user.name).slice(0, 60);
  await user.save();

  if (req.user && String(req.user._id) === String(user._id)) {
    return res.redirect('/dashboard');
  }
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = String(user._id);
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.session.save(() => res.redirect('/dashboard'));
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('dvary.sid');
    res.redirect('/');
  });
});

module.exports = router;
