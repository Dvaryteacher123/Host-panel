import {
  auth, db, API_BASE_URL,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, getDocs,
} from './firebase-config.js';

// ---------------------------------------------------------------
// STATE
// ---------------------------------------------------------------
let currentAdmin = null;
let productsData = {};
let ordersData = {};
let usersData = {};
let supportData = {};
let unsubs = [];

// ---------------------------------------------------------------
// TOAST HELPER
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
function fmtMoney(n) { return 'TZS ' + (Number(n) || 0).toLocaleString('en-US'); }
function fmtDate(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
    if (!d) return '-';
    return d.toLocaleString('sw-TZ', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) { return '-'; }
}

// ---------------------------------------------------------------
// ADMIN LOGIN
// ---------------------------------------------------------------
document.getElementById('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('adminEmail').value.trim();
  const password = document.getElementById('adminPassword').value;
  const btn = document.getElementById('adminLoginBtn');
  const errEl = document.getElementById('adminLoginError');
  errEl.classList.add('hidden');
  btn.disabled = true; btn.innerHTML = '<div class="spinner spinner-sm"></div>';

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const adminDoc = await getDoc(doc(db, 'admins', cred.user.uid));
    if (!adminDoc.exists()) {
      await signOut(auth);
      errEl.textContent = 'Akaunti hii si Admin. Wasiliana na msimamizi mkuu.';
      errEl.classList.remove('hidden');
    }
  } catch (err) {
    const map = {
      'auth/invalid-credential': 'Barua pepe au nenosiri si sahihi.',
      'auth/user-not-found': 'Akaunti haipo.',
      'auth/wrong-password': 'Nenosiri si sahihi.',
      'auth/too-many-requests': 'Majaribio mengi. Jaribu tena baadaye.',
    };
    errEl.textContent = map[err.code] || 'Imeshindikana kuingia. Jaribu tena.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false; btn.innerHTML = '<span class="btn-label">LOGIN</span>';
  }
});

document.getElementById('adminLogoutBtn').addEventListener('click', () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  unsubs.forEach((u) => u());
  unsubs = [];

  if (!user) {
    currentAdmin = null;
    document.getElementById('adminShell').classList.add('hidden');
    document.getElementById('adminLoginScreen').classList.remove('hidden');
    return;
  }

  const adminDoc = await getDoc(doc(db, 'admins', user.uid));
  if (!adminDoc.exists()) return; // itashughulikiwa na login handler / itabaki kwenye login screen

  currentAdmin = user;
  document.getElementById('adminLoginScreen').classList.add('hidden');
  document.getElementById('adminShell').classList.remove('hidden');
  document.getElementById('adminEmailLabel').textContent = user.email || '';
  document.getElementById('settingsEmail').textContent = user.email || '-';
  document.getElementById('settingsUid').textContent = user.uid;

  startListeners();
});

// ---------------------------------------------------------------
// SIDEBAR NAVIGATION
// ---------------------------------------------------------------
const sectionTitles = {
  dashboard: 'Dashboard', products: 'Products', orders: 'Orders', members: 'Members',
  support: 'Support', notifications: 'Notifications', payments: 'Payments', settings: 'Settings',
};

document.querySelectorAll('.admin-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.admin-nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.admin-view').forEach((v) => v.classList.add('hidden'));
    const section = btn.dataset.section;
    document.getElementById(`sec-${section}`).classList.remove('hidden');
    document.getElementById('adminTopTitle').textContent = sectionTitles[section];
    document.getElementById('adminSidebar').classList.remove('open');
  });
});

document.getElementById('burgerBtn').addEventListener('click', () => {
  document.getElementById('adminSidebar').classList.toggle('open');
});

// ---------------------------------------------------------------
// LIVE LISTENERS
// ---------------------------------------------------------------
function startListeners() {
  // PRODUCTS
  const unsubP = onSnapshot(collection(db, 'products'), (snap) => {
    productsData = {};
    snap.forEach((d) => { productsData[d.id] = { ...d.data(), id: d.id }; });
    renderAdminProducts();
  });

  // ORDERS
  const qOrders = query(collection(db, 'orders'), orderBy('createdAt', 'desc'));
  const unsubO = onSnapshot(qOrders, (snap) => {
    ordersData = {};
    snap.forEach((d) => { ordersData[d.id] = { ...d.data(), id: d.id }; });
    renderDashboardStats();
    renderOrdersTable();
    renderPendingOrders();
    renderPaymentsTable();
    renderMembersTable();
    renderNotifications();
  });

  // USERS
  const unsubU = onSnapshot(collection(db, 'users'), (snap) => {
    usersData = {};
    snap.forEach((d) => { usersData[d.id] = { ...d.data(), id: d.id }; });
    renderDashboardStats();
    renderMembersTable();
  });

  // SUPPORT
  const qSupport = query(collection(db, 'supportMessages'), orderBy('createdAt', 'desc'));
  const unsubS = onSnapshot(qSupport, (snap) => {
    supportData = {};
    snap.forEach((d) => { supportData[d.id] = { ...d.data(), id: d.id }; });
    renderSupportMessages();
    renderNotifications();
  });

  unsubs.push(unsubP, unsubO, unsubU, unsubS);
  refreshBalance();
}

// ---------------------------------------------------------------
// DASHBOARD STATS
// ---------------------------------------------------------------
function renderDashboardStats() {
  const orders = Object.values(ordersData);
  const totalMembers = Object.keys(usersData).length;
  const totalOrders = orders.length;
  const pending = orders.filter((o) => o.paymentStatus === 'pending').length;
  const completed = orders.filter((o) => o.paymentStatus === 'paid').length;
  const revenue = orders.filter((o) => o.paymentStatus === 'paid').reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

  document.getElementById('statMembers').textContent = totalMembers;
  document.getElementById('statOrders').textContent = totalOrders;
  document.getElementById('statPending').textContent = pending;
  document.getElementById('statCompleted').textContent = completed;
  document.getElementById('statRevenue').textContent = fmtMoney(revenue);

  const tbody = document.querySelector('#recentOrdersTable tbody');
  const recent = orders.slice(0, 8);
  if (recent.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2);">No data available</td></tr>`;
    return;
  }
  tbody.innerHTML = recent.map((o) => `
    <tr>
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(o.email)}</td>
      <td>${escapeHtml(o.productTitle)}</td>
      <td>${fmtMoney(o.amount)}</td>
      <td>${statusChip(o.paymentStatus)}</td>
      <td>${fmtDate(o.createdAt)}</td>
    </tr>`).join('');
}

function statusChip(status) {
  const map = {
    pending: '<span class="badge badge-pending">PENDING</span>',
    paid: '<span class="badge badge-paid">PAID</span>',
    failed: '<span class="badge badge-failed">FAILED</span>',
  };
  return map[status] || map.pending;
}

// ---------------------------------------------------------------
// PRODUCTS CRUD
// ---------------------------------------------------------------
function renderAdminProducts() {
  const grid = document.getElementById('adminProductsGrid');
  const products = Object.values(productsData);
  if (products.length === 0) {
    grid.innerHTML = `<div class="empty-state"><span class="emoji">🛍️</span><p>No data available</p></div>`;
    return;
  }
  grid.innerHTML = products.map((p) => `
    <div class="admin-product-card glass">
      <img src="${escapeHtml(p.imageUrl || '')}" onerror="this.style.opacity=0.15" />
      <h4>${escapeHtml(p.title)}</h4>
      <p>${escapeHtml(p.description || '').slice(0, 70)}</p>
      <p style="font-weight:800;color:var(--accent-2);">${fmtMoney(p.price)} &middot; ${p.active === false ? '<span class="badge badge-failed">INACTIVE</span>' : '<span class="badge badge-paid">ACTIVE</span>'}</p>
      <div class="admin-product-actions">
        <button class="btn btn-ghost btn-sm" data-edit-product="${p.id}">EDIT</button>
        <button class="btn btn-danger btn-sm" data-delete-product="${p.id}">DELETE</button>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-edit-product]').forEach((btn) => {
    btn.addEventListener('click', () => loadProductIntoForm(btn.dataset.editProduct));
  });
  grid.querySelectorAll('[data-delete-product]').forEach((btn) => {
    btn.addEventListener('click', () => deleteProduct(btn.dataset.deleteProduct));
  });
}

function loadProductIntoForm(id) {
  const p = productsData[id];
  if (!p) return;
  document.getElementById('productId').value = id;
  document.getElementById('pTitle').value = p.title || '';
  document.getElementById('pPrice').value = p.price || '';
  document.getElementById('pDescription').value = p.description || '';
  document.getElementById('pImageUrl').value = p.imageUrl || '';
  document.getElementById('pVideoUrl').value = p.videoUrl || '';
  document.getElementById('pGroupLink').value = p.groupLink || '';
  document.getElementById('pActive').value = p.active === false ? 'false' : 'true';
  document.getElementById('productFormTitle').textContent = 'Hariri Product';
  document.getElementById('productSubmitBtn').textContent = 'SAVE CHANGES';
  document.getElementById('productCancelEditBtn').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetProductForm() {
  document.getElementById('productForm').reset();
  document.getElementById('productId').value = '';
  document.getElementById('productFormTitle').textContent = 'Ongeza Product Mpya';
  document.getElementById('productSubmitBtn').textContent = 'ADD PRODUCT';
  document.getElementById('productCancelEditBtn').classList.add('hidden');
}

document.getElementById('productCancelEditBtn').addEventListener('click', resetProductForm);

document.getElementById('productForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('productId').value;
  const payload = {
    title: document.getElementById('pTitle').value.trim(),
    price: Number(document.getElementById('pPrice').value),
    description: document.getElementById('pDescription').value.trim(),
    imageUrl: document.getElementById('pImageUrl').value.trim(),
    videoUrl: document.getElementById('pVideoUrl').value.trim(),
    groupLink: document.getElementById('pGroupLink').value.trim(),
    active: document.getElementById('pActive').value === 'true',
  };

  const btn = document.getElementById('productSubmitBtn');
  btn.disabled = true;
  try {
    if (id) {
      await updateDoc(doc(db, 'products', id), payload);
      toast('Product imesasishwa!', 'success');
    } else {
      await addDoc(collection(db, 'products'), { ...payload, createdAt: serverTimestamp() });
      toast('Product mpya imeongezwa!', 'success');
    }
    resetProductForm();
  } catch (err) {
    console.error(err);
    toast('Imeshindikana kuhifadhi product.', 'error');
  } finally {
    btn.disabled = false;
  }
});

async function deleteProduct(id) {
  if (!confirm('Una uhakika unataka kufuta product hii?')) return;
  try {
    await deleteDoc(doc(db, 'products', id));
    toast('Product imefutwa.', 'success');
  } catch (err) {
    console.error(err);
    toast('Imeshindikana kufuta product.', 'error');
  }
}

// ---------------------------------------------------------------
// ORDERS TABLE + SEARCH + PENDING + DETAIL MODAL
// ---------------------------------------------------------------
function renderOrdersTable(filterText = '') {
  const tbody = document.querySelector('#ordersTable tbody');
  let orders = Object.values(ordersData);
  if (filterText) {
    const f = filterText.toLowerCase();
    orders = orders.filter((o) => (o.email || '').toLowerCase().includes(f) || (o.id || '').toLowerCase().includes(f));
  }
  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-2);">No data available</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map((o) => `
    <tr data-row-order="${o.id}" style="cursor:pointer;">
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(o.email)}</td>
      <td>${escapeHtml(o.phone)}</td>
      <td>${escapeHtml(o.productTitle)}</td>
      <td>${fmtMoney(o.amount)}</td>
      <td>${statusChip(o.paymentStatus)}</td>
      <td>${escapeHtml(o.deliveryStatus || 'pending')}</td>
      <td>${fmtDate(o.createdAt)}</td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-row-order]').forEach((row) => {
    row.addEventListener('click', () => openOrderDetail(row.dataset.rowOrder));
  });
}

document.getElementById('orderSearch').addEventListener('input', (e) => renderOrdersTable(e.target.value));

function renderPendingOrders() {
  const tbody = document.querySelector('#pendingOrdersTable tbody');
  const pending = Object.values(ordersData).filter((o) => o.paymentStatus === 'pending');
  if (pending.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-2);">No data available</td></tr>`;
    return;
  }
  tbody.innerHTML = pending.map((o) => `
    <tr>
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(o.email)}</td>
      <td>${escapeHtml(o.productTitle)}</td>
      <td>${fmtMoney(o.amount)}</td>
      <td>${fmtDate(o.createdAt)}</td>
    </tr>`).join('');
}

function openOrderDetail(id) {
  const o = ordersData[id];
  if (!o) return;
  document.getElementById('orderDetailBody').innerHTML = `
    <div class="profile-row"><span>Order ID</span><span>${escapeHtml(o.id)}</span></div>
    <div class="profile-row"><span>Email</span><span>${escapeHtml(o.email)}</span></div>
    <div class="profile-row"><span>WhatsApp</span><span>${escapeHtml(o.phone)}</span></div>
    <div class="profile-row"><span>Product</span><span>${escapeHtml(o.productTitle)}</span></div>
    <div class="profile-row"><span>Amount</span><span>${fmtMoney(o.amount)}</span></div>
    <div class="profile-row"><span>Fee</span><span>${o.fee != null ? fmtMoney(o.fee) : '-'}</span></div>
    <div class="profile-row"><span>Net Amount</span><span>${o.netAmount != null ? fmtMoney(o.netAmount) : '-'}</span></div>
    <div class="profile-row"><span>Payment Status</span><span>${statusChip(o.paymentStatus)}</span></div>
    <div class="profile-row"><span>Delivery Status</span><span>${escapeHtml(o.deliveryStatus || 'pending')}</span></div>
    <div class="profile-row"><span>Group Link</span><span>${o.groupLink ? `<a href="${escapeHtml(o.groupLink)}" target="_blank" style="color:var(--accent-2);">Fungua</a>` : '-'}</span></div>
    <div class="profile-row"><span>Created</span><span>${fmtDate(o.createdAt)}</span></div>
    <div class="profile-row"><span>Updated</span><span>${fmtDate(o.updatedAt)}</span></div>
  `;
  document.getElementById('orderDetailModal').classList.remove('hidden');
}
document.getElementById('closeOrderDetail').addEventListener('click', () => {
  document.getElementById('orderDetailModal').classList.add('hidden');
});

// ---------------------------------------------------------------
// MEMBERS TABLE
// ---------------------------------------------------------------
function renderMembersTable(filterText = '') {
  const tbody = document.querySelector('#membersTable tbody');
  let members = Object.values(usersData);
  if (filterText) {
    const f = filterText.toLowerCase();
    members = members.filter((u) => (u.email || '').toLowerCase().includes(f));
  }
  if (members.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-2);">No data available</td></tr>`;
    return;
  }

  const ordersByUser = {};
  Object.values(ordersData).forEach((o) => {
    ordersByUser[o.userId] = (ordersByUser[o.userId] || 0) + 1;
  });

  tbody.innerHTML = members.map((u) => `
    <tr>
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.phone)}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>${ordersByUser[u.id] || 0}</td>
    </tr>`).join('');
}
document.getElementById('memberSearch').addEventListener('input', (e) => renderMembersTable(e.target.value));

// ---------------------------------------------------------------
// SUPPORT MESSAGES + REPLY
// ---------------------------------------------------------------
function renderSupportMessages() {
  const container = document.getElementById('adminSupportContainer');
  const messages = Object.values(supportData);
  if (messages.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="emoji">🛟</span><p>No data available</p></div>`;
    return;
  }
  container.innerHTML = messages.map((m) => {
    const statusChipClass = { open: 'status-open', replied: 'status-replied', closed: 'status-closed' }[m.status] || 'status-open';
    return `
      <div class="support-msg glass" style="margin-bottom:16px;">
        <div class="sm-date">${escapeHtml(m.email)} &middot; ${escapeHtml(m.phone || '')} &middot; ${fmtDate(m.createdAt)} &middot; <span class="status-chip ${statusChipClass}">${escapeHtml(m.status)}</span></div>
        <p class="sm-text">${escapeHtml(m.message)}</p>
        ${m.reply ? `<div class="support-reply" style="margin-bottom:12px;"><b>Jibu lililotumwa:</b> ${escapeHtml(m.reply)}</div>` : ''}
        <div class="field" style="margin-bottom:10px;">
          <textarea rows="2" placeholder="Andika jibu..." data-reply-input="${m.id}">${escapeHtml(m.reply || '')}</textarea>
        </div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary btn-sm" data-send-reply="${m.id}">REPLY</button>
          <button class="btn btn-ghost btn-sm" data-close-ticket="${m.id}">CLOSE</button>
        </div>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-send-reply]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.sendReply;
      const textarea = container.querySelector(`[data-reply-input="${id}"]`);
      const reply = textarea.value.trim();
      if (!reply) { toast('Andika jibu kabla ya kutuma.', 'error'); return; }
      try {
        await updateDoc(doc(db, 'supportMessages', id), { reply, status: 'replied', repliedAt: serverTimestamp() });
        toast('Jibu limetumwa kwa mteja.', 'success');
      } catch (err) {
        console.error(err);
        toast('Imeshindikana kutuma jibu.', 'error');
      }
    });
  });

  container.querySelectorAll('[data-close-ticket]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await updateDoc(doc(db, 'supportMessages', btn.dataset.closeTicket), { status: 'closed' });
        toast('Ticket imefungwa.', 'success');
      } catch (err) {
        console.error(err);
      }
    });
  });
}

// ---------------------------------------------------------------
// NOTIFICATIONS FEED (kutoka orders + support - data halisi)
// ---------------------------------------------------------------
function renderNotifications() {
  const feed = document.getElementById('notificationsFeed');
  const events = [];

  Object.values(ordersData).forEach((o) => {
    events.push({ type: 'order', time: o.createdAt, text: `Order mpya kutoka <b>${escapeHtml(o.email)}</b> kwa ${escapeHtml(o.productTitle)} (${fmtMoney(o.amount)})` });
    if (o.paymentStatus === 'paid') {
      events.push({ type: 'paid', time: o.updatedAt || o.createdAt, text: `Malipo yamekamilika kwa order <b>${escapeHtml(o.id)}</b>` });
    }
  });
  Object.values(supportData).forEach((m) => {
    events.push({ type: 'support', time: m.createdAt, text: `Ujumbe mpya wa support kutoka <b>${escapeHtml(m.email)}</b>` });
  });

  events.sort((a, b) => {
    const ta = a.time?.toMillis ? a.time.toMillis() : 0;
    const tb = b.time?.toMillis ? b.time.toMillis() : 0;
    return tb - ta;
  });

  const top = events.slice(0, 15);
  if (top.length === 0) {
    feed.innerHTML = `<div class="empty-state"><span class="emoji">🔔</span><p>No data available</p></div>`;
    return;
  }
  feed.innerHTML = top.map((ev) => `
    <div class="feed-item">
      <div class="feed-dot"></div>
      <div>
        <div class="feed-text">${ev.text}</div>
        <div class="feed-time">${fmtDate(ev.time)}</div>
      </div>
    </div>`).join('');
}

// ---------------------------------------------------------------
// PAYMENTS: BALANCE + MONITOR
// ---------------------------------------------------------------
async function refreshBalance() {
  const display = document.getElementById('balanceDisplay');
  display.innerHTML = '<div class="spinner spinner-sm"></div>';
  try {
    const idToken = await currentAdmin.getIdToken();
    const res = await fetch(`${API_BASE_URL}/api/admin/balance`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    const data = await res.json();
    if (data.success) {
      const bal = data.balance;
      display.textContent = fmtMoney(bal.balance ?? bal.amount ?? bal.wallet_balance ?? 0);
    } else {
      display.textContent = 'Imeshindikana kupata salio';
    }
  } catch (err) {
    console.error(err);
    display.textContent = 'Imeshindikana kupata salio';
  }
}
document.getElementById('refreshBalanceBtn').addEventListener('click', refreshBalance);

function renderPaymentsTable() {
  const tbody = document.querySelector('#paymentsTable tbody');
  const orders = Object.values(ordersData);
  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--text-2);">No data available</td></tr>`;
    return;
  }
  tbody.innerHTML = orders.map((o) => `
    <tr>
      <td>${escapeHtml(o.harakaPayOrderId || o.id)}</td>
      <td>${fmtMoney(o.amount)}</td>
      <td>${escapeHtml(o.phone)}</td>
      <td>${statusChip(o.paymentStatus)}</td>
      <td>${fmtDate(o.createdAt)}</td>
      <td>${o.paymentStatus === 'paid' ? fmtDate(o.updatedAt) : '-'}</td>
    </tr>`).join('');
}
