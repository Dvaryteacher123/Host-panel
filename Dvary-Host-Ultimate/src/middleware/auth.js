const User = require('../models/User');

// wraps async route handlers so errors reach the error handler
exports.wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

exports.attachUser = async (req, res, next) => {
  res.locals.currentUser = null;
  res.locals.active = '';
  try {
    if (req.session && req.session.userId) {
      const u = await User.findById(req.session.userId).select('-password');
      if (u && !u.banned) { req.user = u; res.locals.currentUser = u; }
      else delete req.session.userId;   // deleted or banned accounts are logged out
    }
    next();
  } catch (e) { next(e); }
};

exports.requireAuth = (req, res, next) => {
  if (!req.user) return res.redirect('/login');
  next();
};

exports.guestOnly = (req, res, next) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  next();
};
