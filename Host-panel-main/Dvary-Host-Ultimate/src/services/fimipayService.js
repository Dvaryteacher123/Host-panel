// Thin client for the FimiPay REST API (https://docs.fimipay.com). Uses Node's built-in fetch (Node 18+).
const crypto = require('crypto');

const baseUrl = () => String(process.env.FIMIPAY_BASE_URL || 'https://fimipay.com/api/v1').replace(/\/+$/, '');
const secretKey = () => String(process.env.FIMIPAY_SECRET_KEY || '').trim();

exports.isConfigured = () => /^sk_(test|live)_/.test(secretKey());
exports.isTestKey = () => secretKey().startsWith('sk_test_');

async function call(path, body) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'FimiPay-Node/1.0',
      Authorization: 'Bearer ' + secretKey()
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(25000)
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (!res.ok || !json || String(json.status || '').toLowerCase() === 'error' || String(json.status || '').toLowerCase() === 'failed') {
    const err = new Error('FimiPay ' + path + ' failed: HTTP ' + res.status + ' ' + text.slice(0, 300));
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

// POST /payment/create_order
exports.createOrder = async (payload) => {
  const json = await call('/payment/create_order', payload);
  const data = json.data || {};
  if (!data.order_id) throw new Error('FimiPay did not return an order_id: ' + JSON.stringify(json).slice(0, 300));
  return data;
};

// POST /payment/order_status
exports.orderStatus = async (orderId) => {
  const json = await call('/payment/order_status', { order_id: orderId });
  return json.data || {};
};

// Webhook signature: HMAC-SHA256 (hex) of the RAW request body with the webhook secret, header X-FIMIPAY-Signature.
exports.verifySignature = (rawBody, signature) => {
  const secret = String(process.env.FIMIPAY_WEBHOOK_SECRET || '');
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = String(signature).trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
