/**
 * server.js
 * Backend ya WhatsApp Groups Shop
 * - Huhifadhi HARAKAPAY_API_KEY salama (env vars pekee)
 * - Ndio inayowasiliana na HarakaPay (frontend haiwasiliani nayo moja kwa moja)
 * - Inatumia Firebase Admin SDK kuandika/kusoma Firestore kwa ruhusa kamili
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ---------------------------------------------------------------
// ENV VARIABLES
// ---------------------------------------------------------------
const PORT = process.env.PORT || 10000;
const HARAKAPAY_API_KEY = process.env.HARAKAPAY_API_KEY;
const HARAKAPAY_BASE_URL = process.env.HARAKAPAY_BASE_URL || 'https://harakapay.net';
const APP_BASE_URL = process.env.APP_BASE_URL;

if (!HARAKAPAY_API_KEY) {
  console.warn('[ONYO] HARAKAPAY_API_KEY haijawekwa kwenye Environment Variables za Render!');
}
if (!APP_BASE_URL) {
  console.warn('[ONYO] APP_BASE_URL haijawekwa. Webhook URL itakuwa batili.');
}

// ---------------------------------------------------------------
// FIREBASE ADMIN INIT
// ---------------------------------------------------------------
const firebasePrivateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: firebasePrivateKey,
  }),
});

const db = admin.firestore();

// ---------------------------------------------------------------
// APP SETUP
// ---------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ---------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------

// Geuza namba ya simu kuwa format ya kimataifa (2557XXXXXXXX)
function normalizePhone(phoneRaw) {
  let p = String(phoneRaw || '').trim().replace(/[\s-]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = '255' + p.slice(1);
  if (!p.startsWith('255')) p = '255' + p;
  return p;
}

function isValidTZPhone(phoneRaw) {
  const p = normalizePhone(phoneRaw);
  return /^255[67]\d{8}$/.test(p);
}

// Fanya request kwenda HarakaPay
async function harakaPayRequest(path, options = {}) {
  const url = `${HARAKAPAY_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'X-API-Key': HARAKAPAY_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data.message || `HarakaPay imerudisha hitilafu (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------
// AUTH MIDDLEWARE (Firebase ID Token)
// ---------------------------------------------------------------
async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Hujaingia (login) — token haipo.' });
    }
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    console.error('verifyToken error:', e.message);
    return res.status(401).json({ success: false, message: 'Token si sahihi au imeisha muda wake.' });
  }
}

async function verifyAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Hujaingia (login) — token haipo.' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    const adminDoc = await db.collection('admins').doc(decoded.uid).get();
    if (!adminDoc.exists) {
      return res.status(403).json({ success: false, message: 'Huna ruhusa ya admin.' });
    }
    next();
  } catch (e) {
    console.error('verifyAdmin error:', e.message);
    return res.status(401).json({ success: false, message: 'Token si sahihi au huna ruhusa.' });
  }
}

// ---------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/**
 * POST /api/payment/create
 * Auth required. Huanzisha USSD Push kupitia HarakaPay na kutengeneza order Firestore.
 * Body: { productId, phone }
 */
app.post('/api/payment/create', verifyToken, async (req, res) => {
  try {
    const { productId, phone } = req.body;

    if (!productId || !phone) {
      return res.status(400).json({ success: false, message: 'productId na phone vinahitajika.' });
    }
    if (!isValidTZPhone(phone)) {
      return res.status(400).json({ success: false, message: 'Namba ya simu si sahihi. Tumia mfano 0712345678.' });
    }
    if (!APP_BASE_URL) {
      return res.status(500).json({ success: false, message: 'Server haijasetiwa vizuri (APP_BASE_URL haipo).' });
    }

    const productSnap = await db.collection('products').doc(productId).get();
    if (!productSnap.exists) {
      return res.status(404).json({ success: false, message: 'Bidhaa (product) haipo.' });
    }
    const product = productSnap.data();
    if (product.active === false) {
      return res.status(400).json({ success: false, message: 'Bidhaa hii haipatikani kwa sasa.' });
    }

    const amount = Number(product.price);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Bei ya bidhaa si sahihi.' });
    }

    const cleanPhone = normalizePhone(phone);
    const webhookUrl = `${APP_BASE_URL.replace(/\/$/, '')}/api/harakapay/webhook`;

    const hpResponse = await harakaPayRequest('/api/v1/collect', {
      method: 'POST',
      body: JSON.stringify({
        phone: cleanPhone,
        amount,
        description: `Malipo ya ${product.title}`,
        webhook_url: webhookUrl,
      }),
    });

    if (!hpResponse.success || !hpResponse.order_id) {
      return res.status(400).json({
        success: false,
        message: hpResponse.message || 'Imeshindikana kuanzisha malipo. Jaribu tena.',
      });
    }

    const orderId = String(hpResponse.order_id);

    const orderData = {
      userId: req.user.uid,
      email: req.user.email || '',
      phone: cleanPhone,
      productId,
      productTitle: product.title,
      amount,
      netAmount: hpResponse.net_amount ?? null,
      fee: hpResponse.fee ?? null,
      harakaPayOrderId: orderId,
      paymentStatus: 'pending',
      deliveryStatus: 'pending',
      groupLink: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('orders').doc(orderId).set(orderData);

    return res.json({
      success: true,
      orderId,
      amount,
      message: hpResponse.message || 'Ombi la malipo limetumwa. Angalia simu yako uthibitishe.',
    });
  } catch (e) {
    console.error('POST /api/payment/create error:', e.message, e.data || '');
    return res.status(500).json({ success: false, message: e.message || 'Hitilafu ya seva imetokea.' });
  }
});

/**
 * POST /api/harakapay/webhook
 * HarakaPay hutuma taarifa hapa. Haihitaji auth (inatoka nje).
 * Idempotent: order isiyobadilishwa mara mbili.
 */
app.post('/api/harakapay/webhook', async (req, res) => {
  try {
    const body = req.body || {};
    const orderId = String(body.order_id || body.orderId || '').trim();
    const rawStatus = String(body.status || body.payment_status || '').toLowerCase().trim();

    if (!orderId) {
      return res.status(400).json({ success: false, message: 'order_id haipo kwenye ujumbe.' });
    }

    const orderRef = db.collection('orders').doc(orderId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(orderRef);
      if (!snap.exists) {
        console.warn('Webhook: order haipatikani Firestore:', orderId);
        return;
      }
      const order = snap.data();

      // IDEMPOTENT: kama tayari imeshughulikiwa, usifanye chochote tena
      if (order.paymentStatus === 'paid' || order.paymentStatus === 'failed') {
        return;
      }

      if (['completed', 'success', 'paid'].includes(rawStatus)) {
        const productSnap = await tx.get(db.collection('products').doc(order.productId));
        const groupLink = productSnap.exists ? productSnap.data().groupLink || null : null;

        tx.update(orderRef, {
          paymentStatus: 'paid',
          deliveryStatus: 'ready',
          groupLink,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else if (['failed', 'cancelled', 'canceled', 'expired'].includes(rawStatus)) {
        tx.update(orderRef, {
          paymentStatus: 'failed',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('POST /api/harakapay/webhook error:', e.message);
    // Bado turudishe 200 ili HarakaPay isiendelee kujaribu bila mwisho kama tatizo ni letu la ndani
    return res.status(200).json({ success: false });
  }
});

/**
 * GET /api/payment/status/:orderId
 * Frontend hupoll HAPA (siyo HarakaPay moja kwa moja).
 * Kama bado pending, backend inauliza HarakaPay status endpoint kama backup ya webhook.
 */
app.get('/api/payment/status/:orderId', verifyToken, async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderRef = db.collection('orders').doc(orderId);
    const snap = await orderRef.get();

    if (!snap.exists) {
      return res.status(404).json({ success: false, message: 'Order haipo.' });
    }

    let order = snap.data();

    if (order.userId !== req.user.uid) {
      const adminDoc = await db.collection('admins').doc(req.user.uid).get();
      if (!adminDoc.exists) {
        return res.status(403).json({ success: false, message: 'Huna ruhusa ya kuona order hii.' });
      }
    }

    if (order.paymentStatus === 'pending') {
      try {
        const hpStatus = await harakaPayRequest(`/api/v1/status/${orderId}`, { method: 'GET' });
        const s = String(hpStatus.status || '').toLowerCase();

        if (['completed', 'success', 'paid'].includes(s)) {
          const productSnap = await db.collection('products').doc(order.productId).get();
          const groupLink = productSnap.exists ? productSnap.data().groupLink || null : null;
          await orderRef.update({
            paymentStatus: 'paid',
            deliveryStatus: 'ready',
            groupLink,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          order = { ...order, paymentStatus: 'paid', deliveryStatus: 'ready', groupLink };
        } else if (['failed', 'cancelled', 'canceled', 'expired'].includes(s)) {
          await orderRef.update({
            paymentStatus: 'failed',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          order = { ...order, paymentStatus: 'failed' };
        }
      } catch (e) {
        console.warn('Status check kwa HarakaPay imeshindikana (tutaendelea kutumia webhook):', e.message);
      }
    }

    return res.json({ success: true, order: { ...order, orderId } });
  } catch (e) {
    console.error('GET /api/payment/status error:', e.message);
    return res.status(500).json({ success: false, message: 'Hitilafu ya seva imetokea.' });
  }
});

/**
 * GET /api/admin/balance
 * Admin pekee. Inasoma salio la HarakaPay wallet.
 */
app.get('/api/admin/balance', verifyAdmin, async (req, res) => {
  try {
    const data = await harakaPayRequest('/api/v1/balance', { method: 'GET' });
    return res.json({ success: true, balance: data });
  } catch (e) {
    console.error('GET /api/admin/balance error:', e.message);
    return res.status(500).json({ success: false, message: e.message || 'Imeshindikana kupata salio.' });
  }
});

// Fallback -> index.html kwa route zisizojulikana za frontend (SPA-style bila router)
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile('index.html', { root: 'public' });
});

app.listen(PORT, () => {
  console.log(`Server inaendesha kwenye port ${PORT}`);
});
