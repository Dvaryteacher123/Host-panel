const express = require('express');
const Notification = require('../models/Notification');
const User = require('../models/User');
const { wrap } = require('../middleware/auth');

const router = express.Router();

// every member can read all notifications; opening the page clears the bell badge
router.get('/notifications', wrap(async (req, res) => {
  const since = req.user.notifSeenAt || req.user.createdAt;
  const items = await Notification.find().sort({ createdAt: -1 }).limit(100).lean();
  items.forEach((n) => { n.fresh = new Date(n.createdAt) > new Date(since); });
  await User.updateOne({ _id: req.user._id }, { $set: { notifSeenAt: new Date() } });
  res.locals.unreadNotif = 0;
  res.render('dashboard/notifications', { active: 'notifications', items });
}));

module.exports = router;
