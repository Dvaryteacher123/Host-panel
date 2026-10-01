import {
  auth, db, API_BASE_URL,
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  collection, doc, setDoc, getDoc, addDoc, onSnapshot, query, where, orderBy, serverTimestamp,
} from './firebase-config.js';

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
let currentUser = null;
let currentProfile = null;
let productsCache = {};
let pollTimer = null;
let unsubProducts = null, unsubOrders = null, unsubSupport = null;

// ---------------------------------------------------------------
// TOASTS
// ---------------------------------------------------------------
function toast(message, type = 'info') {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${escapeHtml(message)}</span>`;
  host.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, 3800);
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.innerText = String(str ?? '');
  return d.innerHTML;
}

function fmtMoney(n) {
  const num = Number(n) || 0;
  return 'TZS ' + num.toLocaleString('en-US');
}

function fmtDate(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('sw-TZ', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return '-'; }
}

// ---------------------------------------------------------------
// AUTH: LOGIN / REGISTER TOGGLE
// ---------------------------------------------------------------
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const toggleAuthBtn = document.getElementById('toggleAuthBtn');
const toggleText = document.getElementById('toggleText');
let showingLogin = true;

toggleAuthBtn.addEventListener('click', () => {
  showingLogin = !showingLogin;
  loginForm.classList.toggle('hidden', !showingLogin);
  registerForm.classList.toggle('hidden', showingLogin);
  toggleAuthBtn.textContent = showingLogin ? 'Jisajili' : 'Ingia';
  toggleText.textContent = showingLogin ? 'Huna akaunti?' : 'Una akaunti tayari?';
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>';
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast('Umeingia kikamilifu!', 'success');
  } catch (err) {
    toast(translateAuthError(err), 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<span class="btn-label">INGIA</span>';
  }
});

registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('regEmail').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  const phoneRegex = /^0[67][0-9]{8}$/;

  if (!phoneRegex.test(phone)) {
    toast('Namba ya WhatsApp si sahihi. Mfano: 0712345678', 'error');
    return;
  }

  const btn = document.getElementById('registerBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>';
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, 'users', cred.user.uid), {
      email,
      phone,
      createdAt: serverTimestamp(),
    });
    toast('Usajili umefanikiwa! Karibu.', 'success');
  } catch (err) {
    toast(translateAuthError(err), 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<span class="btn-label">JISAJILI</span>';
  }
});

function translateAuthError(err) {
  const code = err?.code || '';
  const map = {
    'auth/email-already-in-use': 'Barua pepe hii tayari imesajiliwa.',
    'auth/invalid-email': 'Barua pepe si sahihi.',
    'auth/weak-password': 'Nenosiri ni dhaifu, tumia angalau herufi 6.',
    'auth/user-not-found': 'Akaunti haipo. Jisajili kwanza.',
    'auth/wrong-password': 'Nenosiri si sahihi.',
    'auth/invalid-credential': 'Taarifa za kuingia si sahihi.',
    'auth/too-many-requests': 'Majaribio mengi. Jaribu tena baadaye.',
  };
  return map[code] || 'Hitilafu imetokea. Jaribu tena.';
}

document.getElementById('logoutBtn').addEventListener('click', () => signOut(auth));

// ---------------------------------------------------------------
// AUTH STATE OBSERVER
// ---------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    const snap = await getDoc(doc(db, 'users', user.uid));
    currentProfile = snap.exists() ? snap.data() : { email: user.email, phone: '-' };

    document.getElementById('authScreen').classList.add('hidden');
    document.getElementById('appShell').classList.remove('hidden');
    document.getElementById('headerEmail').textContent = user.email || '';

    fillProfile();
    startProductsListener();
    startOrdersListener();
    startSupportListener();
  } else {
    currentUser = null;
    currentProfile = null;
    document.getElementById('appShell').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    if (unsubProducts) unsubProducts();
    if (unsubOrders) unsubOrders();
    if (unsubSupport) unsubSupport();
  }
});

function fillProfile() {
  const initials = (currentProfile.email || '?').charAt(0).toUpperCase();
  document.getElementById('profileAvatar').textContent = initials;
  document.getElementById('profileNameDisplay').textContent = currentProfile.email || '';
  document.getElementById('profileEmail').textContent = currentProfile.email || '-';
  document.getElementById('profilePhone').textContent = currentProfile.phone || '-';
  document.getElementById('profileJoined').textContent = currentProfile.createdAt ? fmtDate(currentProfile.createdAt) : '-';
}

// ---------------------------------------------------------------
// BOTTOM NAV
// ---------------------------------------------------------------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
    document.getElementById(`view-${btn.dataset.view}`).classList.remove('hidden');
  });
});

// ---------------------------------------------------------------
// PRODUCTS (HOME)
// ---------------------------------------------------------------
function startProductsListener() {
  const container = document.getElementById('productsContainer');
  container.innerHTML = renderSkeletons(4);

  const q = query(collection(db, 'products'), where('active', '==', true));
  unsubProducts = onSnapshot(q, (snap) => {
    productsCache = {};
    if (snap.empty) {
      container.innerHTML = emptyState('📦', 'Hakuna bidhaa kwa sasa. Rudi baadaye.');
      return;
    }
    let html = '';
    snap.forEach((docSnap) => {
      const p = docSnap.data();
      productsCache[docSnap.id] = { ...p, id: docSnap.id };
      html += productCardHtml(docSnap.id, p);
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-buy]').forEach((btn) => {
      btn.addEventListener('click', () => openCheckout(btn.dataset.buy));
    });
  }, (err) => {
    console.error(err);
    container.innerHTML = emptyState('⚠️', 'Imeshindikana kupakia bidhaa.');
  });
}

function productCardHtml(id, p) {
  const media = p.videoUrl
    ? `<video src="${escapeHtml(p.videoUrl)}" muted loop playsinline onmouseover="this.play()" onmouseout="this.pause()"></video><div class="play-badge">▶ VIDEO</div>`
    : `<img src="${escapeHtml(p.imageUrl || '')}" alt="${escapeHtml(p.title)}" onerror="this.style.opacity=0.2" />`;

  return `
    <div class="product-card glass">
      <div class="product-media">${media}</div>
      <div class="product-body">
        <h3 class="product-title">${escapeHtml(p.title)}</h3>
        <p class="product-desc">${escapeHtml(p.description)}</p>
        <div class="product-footer">
          <span class="product-price">${fmtMoney(p.price)}</span>
          <button class="btn btn-primary btn-sm" data-buy="${id}">BUY NOW</button>
        </div>
      </div>
    </div>`;
}

function renderSkeletons(n) {
  let html = '';
  for (let i = 0; i < n; i++) {
    html += `<div class="glass" style="overflow:hidden;">
      <div class="skeleton" style="aspect-ratio:16/10;"></div>
      <div style="padding:20px;">
        <div class="skeleton" style="height:18px;width:70%;margin-bottom:10px;border-radius:6px;"></div>
        <div class="skeleton" style="height:14px;width:100%;margin-bottom:8px;border-radius:6px;"></div>
        <div class="skeleton" style="height:14px;width:90%;border-radius:6px;"></div>
      </div>
    </div>`;
  }
  return html;
}

function emptyState(emoji, text) {
  return `<div class="empty-state"><span class="emoji">${emoji}</span><p>${escapeHtml(text)}</p></div>`;
}

// ---------------------------------------------------------------
// CHECKOUT
// ---------------------------------------------------------------
let activeProductId = null;

function openCheckout(productId) {
  const p = productsCache[productId];
  if (!p) return;
  activeProductId = productId;

  document.getElementById('checkoutImg').src = p.imageUrl || '';
  document.getElementById('checkoutTitle').textContent = p.title;
  document.getElementById('checkoutPrice').textContent = fmtMoney(p.price);
  document.getElementById('checkoutEmail').value = currentUser?.email || '';
  document.getElementById('checkoutPhone').value = currentProfile?.phone || '';

  document.getElementById('checkoutModal').classList.remove('hidden');
}

document.getElementById('closeCheckout').addEventListener('click', () => {
  document.getElementById('checkoutModal').classList.add('hidden');
});

document.getElementById('payNowBtn').addEventListener('click', async () => {
  const phone = document.getElementById('checkoutPhone').value.trim();
  const phoneRegex = /^0[67][0-9]{8}$/;
  if (!phoneRegex.test(phone)) {
    toast('Weka namba sahihi ya WhatsApp. Mfano: 0712345678', 'error');
    return;
  }

  const btn = document.getElementById('payNowBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner spinner-sm"></div>';

  try {
    const idToken = await currentUser.getIdToken();
    const res = await fetch(`${API_BASE_URL}/api/payment/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ productId: activeProductId, phone }),
    });
    const data = await res.json();

    if (!data.success) {
      toast(data.message || 'Imeshindikana kuanzisha malipo.', 'error');
      return;
    }

    document.getElementById('checkoutModal').classList.add('hidden');
    showPaymentPending(data.orderId, data.amount);
    pollPaymentStatus(data.orderId);
  } catch (err) {
    console.error(err);
    toast('Hitilafu ya mtandao. Jaribu tena.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="btn-label">LIPA SASA (PAY NOW)</span>';
  }
});

// ---------------------------------------------------------------
// PAYMENT STATUS UI
// ---------------------------------------------------------------
function showPaymentPending(orderId, amount) {
  const body = document.getElementById('paymentModalBody');
  body.innerHTML = `
    <div class="pay-state">
      <div class="pay-icon pending"><div class="spinner"></div></div>
      <h3 class="pay-title">PAYMENT PENDING</h3>
      <p class="pay-sub">Angalia simu yako na uthibitishe malipo (USSD Push imetumwa).</p>
      <div class="pay-meta"><span>Order ID</span><span>${escapeHtml(orderId)}</span></div>
      <div class="pay-meta"><span>Kiasi</span><span>${fmtMoney(amount)}</span></div>
      <div class="pay-meta"><span>Status</span><span id="payStatusLabel" class="badge badge-pending">PENDING</span></div>
    </div>`;
  document.getElementById('paymentModal').classList.remove('hidden');
}

function showPaymentSuccess(order) {
  const body = document.getElementById('paymentModalBody');
  body.innerHTML = `
    <div class="pay-state">
      <div class="pay-icon success">✓</div>
      <h3 class="pay-title">PAYMENT SUCCESSFUL ✓</h3>
      <p class="pay-sub">ORDER COMPLETED — Bofya chini kupata link ya kikundi.</p>
      <div class="pay-meta"><span>Order ID</span><span>${escapeHtml(order.orderId)}</span></div>
      <div class="pay-meta"><span>Kiasi</span><span>${fmtMoney(order.amount)}</span></div>
      <a href="${escapeHtml(order.groupLink || '#')}" target="_blank" rel="noopener" class="btn btn-primary btn-block" style="margin-top:18px;">
        OPEN WHATSAPP GROUP
      </a>
      <button class="btn btn-ghost btn-block" style="margin-top:10px;" id="closePaymentModalBtn">FUNGA</button>
    </div>`;
  document.getElementById('paymentModal').classList.remove('hidden');
  document.getElementById('closePaymentModalBtn').addEventListener('click', () => {
    document.getElementById('paymentModal').classList.add('hidden');
  });
}

function showPaymentFailed(order) {
  const body = document.getElementById('paymentModalBody');
  body.innerHTML = `
    <div class="pay-state">
      <div class="pay-icon failed">✕</div>
      <h3 class="pay-title">MALIPO HAYAJAFANIKIWA</h3>
      <p class="pay-sub">Jaribu tena au wasiliana na SUPPORT kama tatizo litaendelea.</p>
      <div class="pay-meta"><span>Order ID</span><span>${escapeHtml(order.orderId)}</span></div>
      <button class="btn btn-primary btn-block" style="margin-top:18px;" id="closePaymentModalBtn2">FUNGA</button>
    </div>`;
  document.getElementById('paymentModal').classList.remove('hidden');
  document.getElementById('closePaymentModalBtn2').addEventListener('click', () => {
    document.getElementById('paymentModal').classList.add('hidden');
  });
}

function pollPaymentStatus(orderId) {
  if (pollTimer) clearInterval(pollTimer);
  let attempts = 0;
  pollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 40) { clearInterval(pollTimer); return; } // ~ dakika 2-3
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`${API_BASE_URL}/api/payment/status/${orderId}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json();
      if (!data.success) return;

      const order = data.order;
      if (order.paymentStatus === 'paid') {
        clearInterval(pollTimer);
        showPaymentSuccess(order);
      } else if (order.paymentStatus === 'failed') {
        clearInterval(pollTimer);
        showPaymentFailed(order);
      }
    } catch (err) {
      console.error('poll error', err);
    }
  }, 4000);
}

// ---------------------------------------------------------------
// ORDERS VIEW
// ---------------------------------------------------------------
function startOrdersListener() {
  const container = document.getElementById('ordersContainer');
  container.innerHTML = renderSkeletons(2);

  const q = query(collection(db, 'orders'), where('userId', '==', currentUser.uid), orderBy('createdAt', 'desc'));
  unsubOrders = onSnapshot(q, (snap) => {
    if (snap.empty) {
      container.innerHTML = emptyState('🧾', 'Bado huna order yoyote.');
      return;
    }
    let html = '';
    snap.forEach((d) => {
      const o = d.data();
      html += orderCardHtml(d.id, o);
    });
    container.innerHTML = html;

    container.querySelectorAll('[data-open-order]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const orderId = btn.dataset.openOrder;
        const link = btn.dataset.link;
        if (link) window.open(link, '_blank');
      });
    });
  }, (err) => {
    console.error(err);
    container.innerHTML = emptyState('⚠️', 'Imeshindikana kupakia order zako.');
  });
}

function orderCardHtml(id, o) {
  const statusBadge = {
    pending: '<span class="badge badge-pending">PENDING</span>',
    paid: '<span class="badge badge-paid">PAID</span>',
    failed: '<span class="badge badge-failed">FAILED</span>',
  }[o.paymentStatus] || '<span class="badge badge-pending">PENDING</span>';

  let actionHtml = '';
  if (o.paymentStatus === 'paid' && o.groupLink) {
    actionHtml = `<button class="btn btn-primary btn-block" data-open-order="${id}" data-link="${escapeHtml(o.groupLink)}">OPEN GROUP</button>`;
  } else if (o.paymentStatus === 'pending') {
    actionHtml = `<div style="text-align:center;color:var(--text-2);font-size:13px;">Waiting for payment...</div>`;
  } else if (o.paymentStatus === 'failed') {
    actionHtml = `<div style="text-align:center;color:var(--danger);font-size:13px;font-weight:700;">Malipo hayakufanikiwa</div>`;
  }

  return `
    <div class="order-card glass">
      <div class="order-top">
        <div>
          <p class="ot-title">${escapeHtml(o.productTitle || '')}</p>
          <span class="ot-id">Order ID: ${escapeHtml(id)}</span>
        </div>
        ${statusBadge}
      </div>
      <div class="order-row"><span>Kiasi</span><span>${fmtMoney(o.amount)}</span></div>
      <div class="order-row"><span>Tarehe</span><span>${fmtDate(o.createdAt)}</span></div>
      <div class="order-row"><span>Delivery</span><span>${escapeHtml(o.deliveryStatus || 'pending')}</span></div>
      <div class="order-actions">${actionHtml}</div>
    </div>`;
}

// ---------------------------------------------------------------
// SUPPORT VIEW
// ---------------------------------------------------------------
document.getElementById('sendSupportBtn').addEventListener('click', async () => {
  const msgBox = document.getElementById('supportMsg');
  const message = msgBox.value.trim();
  if (!message) { toast('Andika ujumbe kwanza.', 'error'); return; }

  const btn = document.getElementById('sendSupportBtn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>';
  try {
    await addDoc(collection(db, 'supportMessages'), {
      userId: currentUser.uid,
      email: currentProfile.email || currentUser.email,
      phone: currentProfile.phone || '',
      message,
      status: 'open',
      reply: null,
      createdAt: serverTimestamp(),
    });
    msgBox.value = '';
    toast('Ujumbe wako umetumwa!', 'success');
  } catch (err) {
    console.error(err);
    toast('Imeshindikana kutuma ujumbe.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'SEND MESSAGE';
  }
});

function startSupportListener() {
  const container = document.getElementById('supportContainer');
  const q = query(collection(db, 'supportMessages'), where('userId', '==', currentUser.uid), orderBy('createdAt', 'desc'));
  unsubSupport = onSnapshot(q, (snap) => {
    if (snap.empty) {
      container.innerHTML = emptyState('🛟', 'Bado hujatuma ujumbe wowote.');
      return;
    }
    let html = '';
    snap.forEach((d) => {
      const m = d.data();
      const statusChip = { open: 'status-open', replied: 'status-replied', closed: 'status-closed' }[m.status] || 'status-open';
      html += `
        <div class="support-msg glass">
          <div class="sm-date">${fmtDate(m.createdAt)} &middot; <span class="status-chip ${statusChip}">${escapeHtml(m.status || 'open')}</span></div>
          <p class="sm-text">${escapeHtml(m.message)}</p>
          ${m.reply ? `<div class="support-reply"><b>Jibu la Support:</b> ${escapeHtml(m.reply)}</div>` : ''}
        </div>`;
    });
    container.innerHTML = html;
  }, (err) => console.error(err));
}
