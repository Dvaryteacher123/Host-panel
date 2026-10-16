module.exports = function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { code: 403, message: 'Access denied.' });
  }
  next();
};
