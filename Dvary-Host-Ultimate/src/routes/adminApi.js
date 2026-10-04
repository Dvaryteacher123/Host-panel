const express = require('express');
const mongoose = require('mongoose');
const ApiKey = require('../models/ApiKey');
const audit = require('../services/auditService');
const { wrap } = require('../middleware/auth');

const router = express.Router();

router.get('/api-keys', wrap(async (req, res) => {
  const list = await ApiKey.find().sort({ revoked: 1, createdAt: -1 }).limit(300).populate('user', 'name email').lean();
  res.render('admin/api-keys', { active: 'apikeys', pageTitle: 'API Apps', list });
}));

router.post('/api-keys/:id/revoke', wrap(async (req, res) => {
  if (mongoose.isValidObjectId(req.params.id)) {
    const k = await ApiKey.findByIdAndUpdate(req.params.id, { $set: { revoked: true } });
    if (k) await audit(req, 'revoke_api_key', k.name, String(k.user));
  }
  req.flash('success', 'API key revoked.');
  res.redirect('/admin/api-keys');
}));

module.exports = router;
