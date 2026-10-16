const crypto = require('crypto');
const GiftCode = require('../models/GiftCode');
const wallet = require('./walletService');

exports.makeCode = () => 'DV-' + crypto.randomBytes(4).toString('hex').toUpperCase();

// the customer typed a code: give the coins ONCE per customer (atomic, so two taps cannot double-spend it)
exports.redeem = async (userId, rawCode) => {
  const code = String(rawCode || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!/^[A-Z0-9-]{4,30}$/.test(code)) throw Object.assign(new Error('This code is not valid.'), { code: 'BAD_CODE' });
  const g = await GiftCode.findOneAndUpdate(
    { code, active: true, 'usedBy.user': { $ne: userId }, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }], $expr: { $lt: [{ $size: '$usedBy' }, '$maxUses'] } },
    { $push: { usedBy: { user: userId, at: new Date() } } }, { new: true }
  );
  if (!g) throw Object.assign(new Error('This code is invalid, expired, already used, or fully used.'), { code: 'BAD_CODE' });
  try {
    await wallet.creditCoins(userId, g.coins, 'Gift code ' + g.code, { giftCode: String(g._id) });
  } catch (e) {
    await GiftCode.updateOne({ _id: g._id }, { $pull: { usedBy: { user: userId } } });   // could not credit: let him try again
    throw e;
  }
  return g;
};
