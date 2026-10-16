const AuditLog = require('../models/AuditLog');

// usage: await audit(req, 'give_coins', user.email, '+500 coins. Payment received')
// A failing log write must never break the admin action itself.
async function audit(req, action, target, detail) {
  try {
    await AuditLog.create({
      admin: req.user._id, adminName: req.user.name, action,
      target: String(target || '').slice(0, 200), detail: String(detail || '').slice(0, 500), ip: req.ip
    });
  } catch (e) { console.error('audit log failed', e); }
}

module.exports = audit;
module.exports.log = audit;
