const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { wrap, guestOnly } = require('../middleware/auth');

const router = express.Router();
const enabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const callbackUrl = (req) => process.env.GOOGLE_CALLBACK_URL || `${req.protocol}://${req.get('host')}/auth/google/callback`;
const back = (req, res, msg) => { req.flash('error', msg); return res.redirect('/login'); };

// 1) send the visitor to Google
router.get('/auth/google', guestOnly, (req, res) => {
  if (!enabled()) return back(req, res, 'Google sign-in is not configured.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.googleState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  req.session.save(() => res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params));
});

// 2) Google sends the visitor back here with ?code=...
router.get('/auth/google/callback', guestOnly, wrap(async (req, res) => {
  if (!enabled()) return back(req, res, 'Google sign-in is not configured.');
  const { code, state, error } = req.query;
  const expected = req.session.googleState;
  delete req.session.googleState;
  if (error) return back(req, res, 'Google sign-in was cancelled.');
  if (!code || !state || !expected || state !== expected) return back(req, res, 'Google sign-in failed (invalid state). Please try again.');

  let profile;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(req),
        grant_type: 'authorization_code'
      })
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok || !token.access_token) throw new Error(token.error_description || token.error || 'token exchange failed');
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + token.access_token } });
    profile = await infoRes.json();
    if (!infoRes.ok || !profile.sub) throw new Error('could not read Google profile');
  } catch (e) {
    console.error('[GOOGLE LOGIN ERROR]', e.message);
    return back(req, res, 'Google sign-in failed: ' + e.message);
  }

  const email = String(profile.email || '').trim().toLowerCase();
  if (!email || profile.email_verified !== true) return back(req, res, 'Your Google email is not verified.');

  // find by Google id, else by email (and link), else create
  let user = await User.findOne({ googleId: profile.sub });
  if (!user) user = await User.findOne({ email: { $eq: email } });
  if (user) {
    if (!user.googleId) { user.googleId = profile.sub; await user.save(); }
  } else {
    if (res.locals.site.registrationOpen === false) return back(req, res, 'Registration is currently closed.');
    const name = String(profile.name || email.split('@')[0]).trim().slice(0, 60).padEnd(2, '_');
    try {
      user = await User.create({
        name, email, googleId: profile.sub, role: 'user', coins: 0,
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12)   // Google users never use it
      });
    } catch (e) {
      if (e.code !== 11000) { console.error('[GOOGLE REGISTER ERROR]', e); return back(req, res, 'Could not create your account: ' + e.message); }
      user = await User.findOne({ email: { $eq: email } });   // created a moment ago by a parallel request
      if (!user) return back(req, res, 'Could not create your account (duplicate).');
    }
  }

  if (user.banned) return back(req, res, 'This account is suspended. Please contact support.');
  await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
  const dest = user.role === 'admin' ? '/admin' : '/dashboard';
  req.session.regenerate((err) => {
    if (err) { console.error(err); return res.redirect('/login'); }
    req.session.userId = String(user._id);
    req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.session.save(() => res.redirect(dest));
  });
}));

module.exports = router;
