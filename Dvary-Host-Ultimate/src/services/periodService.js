// Plans can sell the same server for different durations (1 day free trial, 1 month, 1 year, 2 years ...).
// A plan with no periods keeps the old behaviour: one price, no expiry.
function label(days) {
  days = Number(days);
  if (days === 1) return '1 Day';
  if (days === 7) return '1 Week';
  if (days >= 365 && days % 365 === 0) { const n = days / 365; return n === 1 ? '1 Year' : n + ' Years'; }
  if (days >= 30 && days % 30 === 0) { const n = days / 30; return n === 1 ? '1 Month' : n + ' Months'; }
  return days + ' Days';
}
exports.label = label;

// normalised list: [{ index, days, label, free, coins, priceTZS, prices }]
exports.list = (plan) => ((plan && plan.periods) || []).map((p, i) => ({
  index: i, days: p.days, label: label(p.days), free: !!p.free,
  coins: p.free ? 0 : (p.coins || 0), priceTZS: p.free ? 0 : (p.priceTZS || 0), prices: p.free ? {} : (p.prices || {})
}));

exports.pick = (plan, idx) => {
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0) return null;
  return exports.list(plan)[n] || null;
};

exports.addDays = (from, days) => new Date(new Date(from).getTime() + days * 86400000);
