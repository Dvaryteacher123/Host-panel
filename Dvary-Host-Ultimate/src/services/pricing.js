// Admin types ONE price per country (in that country's own currency). No conversion anywhere.
const CURS = ['TZS', 'KES', 'UGX', 'NGN', 'GHS', 'XAF', 'ZAR'];
exports.CURS = CURS;

// reads fields named price_TZS, price_KES ... (or <prefix>TZS) -> { priceTZS, prices: { KES: 300, ... } }
exports.parse = (body, prefix) => {
  const pre = prefix || 'price_';
  const out = { priceTZS: 0, prices: {} };
  CURS.forEach((c) => {
    const n = Math.floor(Number(String((body || {})[pre + c] || '').replace(/[, ]/g, '')));
    if (n > 0) { if (c === 'TZS') out.priceTZS = n; else out.prices[c] = n; }
  });
  return out;
};

// does the item have at least one country price?
exports.any = (o) => Number(o && o.priceTZS) > 0 || Object.keys((o && o.prices) || {}).some((k) => Number(o.prices[k]) > 0);
