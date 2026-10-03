const express = require('express');
const mongoose = require('mongoose');
const Zip = require('../models/Zip');
const ZipAccess = require('../models/ZipAccess');
const { wrap } = require('../middleware/auth');

const router = express.Router();
const validId = (id) => mongoose.isValidObjectId(id);

// ZIP Shop (its own section: Free ZIPs and VIP ZIPs that are bought with money)
router.get('/zips', wrap(async (req, res) => {
  const tab = req.query.tab === 'vip' ? 'vip' : 'free';
  const [zips, access] = await Promise.all([
    Zip.find({ active: true, type: tab }).select('-url').sort({ createdAt: -1 }).limit(100).lean(),
    ZipAccess.find({ user: req.user._id }).select('zip').lean()
  ]);
  const owned = {};
  access.forEach((a) => { owned[String(a.zip)] = true; });
  res.render('dashboard/zips', { active: 'zips', tab, zips, owned });
}));

// the MediaFire link is only given out for free ZIPs, ZIPs the customer paid for, or to an admin
router.get('/zips/:id/get', wrap(async (req, res) => {
  if (!validId(req.params.id)) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  const zip = await Zip.findOne({ _id: req.params.id, active: true });
  if (!zip) return res.status(404).render('error', { code: 404, message: 'Page not found.' });
  const allowed = zip.type === 'free' || req.user.role === 'admin' || await ZipAccess.exists({ user: req.user._id, zip: zip._id });
  if (!allowed) { req.flash('error', 'Buy this VIP ZIP first.'); return res.redirect('/dashboard/zips?tab=vip'); }
  await Zip.updateOne({ _id: zip._id }, { $inc: { downloads: 1 } });
  return res.redirect(zip.url);
}));

module.exports = router;
