const crypto = require('crypto');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

const MAX_AMOUNT = 1000000000;

class WalletError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function newReference() {
  return 'TX-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function cleanAmount(amount) {
  const n = Number(amount);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_AMOUNT) throw new WalletError('INVALID_AMOUNT', 'Amount must be a positive whole number');
  return n;
}

// One atomic $inc on the user document. Debits only match when coins >= amount,
// so the balance can never go negative and double spending is impossible.
async function apply(userId, type, amount, description, meta) {
  const n = cleanAmount(amount);
  const filter = { _id: userId };
  if (type === 'debit') filter.coins = { $gte: n };
  const inc = type === 'debit' ? -n : n;

  const user = await User.findOneAndUpdate(filter, { $inc: { coins: inc } }, { new: true });
  if (!user) {
    const exists = await User.exists({ _id: userId });
    if (!exists) throw new WalletError('NO_USER', 'User not found');
    throw new WalletError('INSUFFICIENT', 'Insufficient Coins');
  }
  try {
    const transaction = await Transaction.create({
      user: user._id, type, amount: n, balanceAfter: user.coins,
      description: description || '', reference: newReference(), meta: meta || {}
    });
    return { user, transaction };
  } catch (err) {
    // the ledger entry failed: undo the balance change so wallet and ledger stay consistent
    await User.updateOne({ _id: userId }, { $inc: { coins: -inc } });
    throw err;
  }
}

exports.WalletError = WalletError;
exports.creditCoins = (userId, amount, description, meta) => apply(userId, 'credit', amount, description || 'Coins credit', meta);
exports.debitCoins = (userId, amount, description, meta) => apply(userId, 'debit', amount, description || 'Coins debit', meta);
exports.refundCoins = (userId, amount, description, meta) => apply(userId, 'refund', amount, description || 'Refund', meta);
