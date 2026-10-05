const crypto = require('crypto');
const fs = require('fs/promises');
const User = require('../models/User');

const base = () => String(process.env.PTERODACTYL_URL || '').replace(/\/+$/, '');

exports.isConfigured = () => {
  const url = base();
  const key = process.env.PTERODACTYL_API_KEY || '';
  return !!(url && key && !key.includes('CHANGE_ME') && !url.includes('panel.example.com'));
};

exports.maskedKey = () => {
  const k = process.env.PTERODACTYL_API_KEY || '';
  if (!k) return '(not set)';
  return k.slice(0, 4) + '••••••••' + k.slice(-4);
};

exports.baseUrl = () => base();
exports.panelUrl = (identifier) => `${base()}/server/${identifier}`;

async function api(method, path, body) {
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await apiOnce(method, path, body); } catch (e) {
      lastErr = e;
      if (e.status !== 429 && e.status !== 502 && e.status !== 503 && e.status !== 504) throw e;
      await new Promise((r) => setTimeout(r, Math.min(3000 * (attempt + 1), 15000)));
    }
  }
  throw lastErr;
}
async function apiOnce(method, path, body) {
  const res = await fetch(`${base()}/api/application${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.PTERODACTYL_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'Application/vnd.pterodactyl.v1+json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  
  if (!res.ok) {
    const errorMsg = `Pterodactyl ${res.status} ${method} ${path}: ${text.slice(0, 600)}`;
    console.error("PANEL API ERROR:", errorMsg);
    const err = new Error(errorMsg);
    err.status = res.status;
    throw err;
  }
  return data;
}

function makeUsername(email) {
  let u = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (u.length < 3) u = 'user' + u;
  return u.slice(0, 20) + crypto.randomBytes(2).toString('hex');
}

// Finds or creates the panel account for this customer.
// SECURITY: the password of an EXISTING panel account is never changed or shown
// (otherwise anybody could register with an admin's email and take over that account).
// A password is generated only for brand-new panel accounts and shown once.
exports.ensureUser = async (user) => {
  const email = user.email.toLowerCase();
  const found = await api('GET', `/users?filter[email]=${encodeURIComponent(email)}`);
  const match = ((found && found.data) || []).find((u) => u.attributes.email.toLowerCase() === email);

  let id;
  let generatedPassword = null;
  if (match) {
    id = match.attributes.id;
  } else {
    generatedPassword = crypto.randomBytes(18).toString('base64url') + 'aA1';
    const parts = user.name.trim().split(/\s+/);
    const created = await api('POST', '/users', {
      email,
      username: makeUsername(email),
      first_name: (parts[0] || 'User').slice(0, 50),
      last_name: (parts.slice(1).join(' ') || 'Dvary').slice(0, 50),
      password: generatedPassword
    });
    id = created.attributes.id;
  }
  if (!user.pteroUserId || user.pteroUserId !== id) {
    await User.updateOne({ _id: user._id }, { $set: { pteroUserId: id } });
  }
  return { id, generatedPassword, created: !match };
};

exports.createServer = async ({ pteroUserId, plan, bot, name, externalId }) => {
  const nestId = Number((plan && plan.nestId) || (bot && bot.nestId) || process.env.PTERODACTYL_NEST_ID);
  const eggId = Number((plan && plan.eggId) || (bot && bot.eggId) || process.env.PTERODACTYL_EGG_ID);
  const locationId = Number(process.env.PTERODACTYL_LOCATION_ID);
  if (!nestId || !eggId || !locationId) throw new Error('PTERODACTYL_NEST_ID / EGG_ID / LOCATION_ID are not configured');

  const egg = await api('GET', `/nests/${nestId}/eggs/${eggId}?include=variables`);
  const eggAttr = egg.attributes;
  const environment = {};
  (((eggAttr.relationships || {}).variables || {}).data || []).forEach((v) => {
    environment[v.attributes.env_variable] = v.attributes.default_value;
  });
  if (bot && bot.environment) Object.assign(environment, bot.environment);

  const body = {
    name,
    user: pteroUserId,
    egg: eggId,
    docker_image: (plan && plan.dockerImage) || (bot && bot.dockerImage) || process.env.PTERODACTYL_DOCKER_IMAGE || eggAttr.docker_image,
    startup: (plan && plan.startup) || (bot && bot.startup) || process.env.PTERODACTYL_STARTUP || eggAttr.startup,
    environment,
    external_id: externalId ? String(externalId).slice(0, 191) : undefined,
    limits: { memory: plan.memory, swap: 0, disk: plan.disk, io: 500, cpu: plan.cpu },
    feature_limits: { databases: plan.databases, backups: plan.backups, allocations: 1 },
    start_on_completion: false
  };
  if (process.env.PTERODACTYL_ALLOCATION_ID) {
    body.allocation = { default: Number(process.env.PTERODACTYL_ALLOCATION_ID) };
  } else {
    body.deploy = { locations: [locationId], dedicated_ip: false, port_range: [] };
  }
  const res = await api('POST', '/servers', body);
  const a = res.attributes;
  return { id: a.id, identifier: a.identifier, uuid: a.uuid };
};

// ---------- lists for the admin template form (Nest -> Egg -> Docker image / variables) ----------
// Reset the password of a panel account that THIS site created (never touches admin accounts).
exports.resetUserPassword = async (pteroUserId, newPassword) => {
  const cur = await api('GET', `/users/${Number(pteroUserId)}`);
  const a = cur.attributes;
  if (a.root_admin) { const e = new Error('Refusing to change an administrator account.'); e.code = 'admin'; throw e; }
  await api('PATCH', `/users/${Number(pteroUserId)}`, {
    email: a.email, username: a.username, first_name: a.first_name, last_name: a.last_name, language: a.language || 'en', password: newPassword
  });
  return true;
};

exports.listNests = async () => {
  const r = await api('GET', '/nests?per_page=100');
  return (r.data || []).map((n) => ({ id: n.attributes.id, name: n.attributes.name }));
};
exports.listEggs = async (nestId) => {
  const r = await api('GET', `/nests/${Number(nestId)}/eggs?include=variables&per_page=100`);
  return (r.data || []).map((e) => {
    const a = e.attributes;
    let images = [];
    if (a.docker_images && typeof a.docker_images === 'object') images = Object.entries(a.docker_images).map(([label, image]) => ({ label, image }));
    else if (a.docker_image) images = [{ label: a.docker_image, image: a.docker_image }];
    const vars = (((a.relationships || {}).variables || {}).data || []).map((v) => ({ key: v.attributes.env_variable, name: v.attributes.name }));
    return { id: a.id, name: a.name, startup: a.startup || '', images, vars };
  });
};

exports.suspendServer = (pteroId) => api('POST', `/servers/${pteroId}/suspend`);
exports.unsuspendServer = (pteroId) => api('POST', `/servers/${pteroId}/unsuspend`);
exports.deleteServer = (pteroId) => api('DELETE', `/servers/${pteroId}`);
// Turns the customer's panel account into a root admin (or back into a normal user).
// The panel API needs the full profile on update, so read it first and send it back.
exports.setRootAdmin = async (pteroUserId, value) => {
  const cur = await api('GET', `/users/${pteroUserId}`);
  const a = cur.attributes;
  await api('PATCH', `/users/${pteroUserId}`, {
    email: a.email, username: a.username, first_name: a.first_name, last_name: a.last_name,
    language: a.language || 'en', root_admin: !!value
  });
};
exports.deleteUser = (pteroUserId) => api('DELETE', `/users/${pteroUserId}`);


// ---------- set one egg variable on an existing server (used for the WhatsApp pairing number) ----------
exports.setEnvVar = async (pteroId, key, value) => {
  const res = await api('GET', `/servers/${pteroId}?include=variables`);
  const a = res.attributes;
  const vars = (((a.relationships || {}).variables || {}).data || []).map((v) => v.attributes);
  const names = vars.map((v) => v.env_variable);
  if (!names.includes(key)) {
    const e = new Error(`Variable ${key} does not exist on this server's egg`);
    e.code = 'novar';
    throw e;
  }
  const cur = (a.container && a.container.environment) || {};
  const environment = {};
  vars.forEach((v) => {
    const val = v.server_value !== undefined && v.server_value !== null ? v.server_value : (cur[v.env_variable] !== undefined ? cur[v.env_variable] : v.default_value);
    environment[v.env_variable] = val === null || val === undefined ? '' : String(val);
  });
  environment[key] = String(value);
  await api('PATCH', `/servers/${pteroId}/startup`, {
    startup: a.container.startup_command, environment, egg: a.egg, image: a.container.image, skip_scripts: false
  });
};

// ---------- Client API (power buttons + live console). Needs PTERODACTYL_CLIENT_API_KEY ----------
const clientKey = () => process.env.PTERODACTYL_CLIENT_API_KEY || '';
exports.clientConfigured = () => !!(base() && clientKey() && !clientKey().includes('CHANGE_ME'));

// All client-API calls go through ONE queue with a small gap between calls and automatic retry on
// 429 (Too Many Attempts) / 5xx, so many customers deploying at once never trip the panel rate limit.
const GAP_MS = Number(process.env.PTERO_CLIENT_GAP_MS || 350);
let queueTail = Promise.resolve();
let lastCall = 0;
let blockedUntil = 0;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function throttled(fn) {
  const run = queueTail.then(async () => {
    const wait = Math.max(lastCall + GAP_MS - Date.now(), blockedUntil - Date.now(), 0);
    if (wait) await sleepMs(wait);
    lastCall = Date.now();
    return fn();
  });
  queueTail = run.catch(() => {});
  return run;
}
async function withRetry(doRequest, label) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await throttled(doRequest);
    } catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504 || e.name === 'TimeoutError';
      if (!retryable) throw e;
      const secs = Number(e.retryAfter) > 0 ? Number(e.retryAfter) : Math.min(3 * (attempt + 1), 20);
      blockedUntil = Math.max(blockedUntil, Date.now() + secs * 1000);
      console.warn(`[ptero] ${label} -> ${e.status || e.name}, retry ${attempt + 1} in ${secs}s`);
    }
  }
  throw lastErr;
}

async function clientApi(method, path, body) {
  return withRetry(async () => {
    const res = await fetch(`${base()}/api/client${path}`, {
      method,
      headers: { Authorization: `Bearer ${clientKey()}`, 'Content-Type': 'application/json', Accept: 'Application/vnd.pterodactyl.v1+json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Pterodactyl client ${res.status} ${method} ${path}: ${text.slice(0, 400)}`);
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }, `${method} ${path.split('?')[0]}`);
}

exports.power = (identifier, signal) => {
  if (!['start', 'stop', 'restart', 'kill'].includes(signal)) throw new Error('Invalid power signal');
  return clientApi('POST', `/servers/${identifier}/power`, { signal });
};

// send a line to the server console (stdin of the bot, e.g. answers a "Enter your number" prompt)
exports.sendCommand = (identifier, command) => clientApi('POST', `/servers/${identifier}/command`, { command: String(command) });
exports.powerState = async (identifier) => {
  const r = await clientApi('GET', `/servers/${identifier}/resources`);
  return (r && r.attributes && r.attributes.current_state) || 'offline';
};

// live usage of a server (cpu %, memory, disk, network) from the client API
exports.resourceUsage = async (identifier) => {
  const r = await clientApi('GET', `/servers/${identifier}/resources`);
  const a = (r && r.attributes) || {};
  const u = a.resources || {};
  return { state: a.current_state || 'offline', cpuPercent: Math.round((u.cpu_absolute || 0) * 100) / 100, memoryBytes: u.memory_bytes || 0, diskBytes: u.disk_bytes || 0, networkRxBytes: u.network_rx_bytes || 0, networkTxBytes: u.network_tx_bytes || 0, uptimeMs: u.uptime || 0 };
};

exports.waitUntilReady = async (identifier, timeoutMs = 240000) => {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await clientApi('GET', `/servers/${identifier}`);
      const a = res?.attributes || {};
      last = a?.status || a?.state || '';
      // Installing is reported by the server as installing/suspended/install_failed.
      if (!a.is_installing && last !== 'install_failed') return a;
      if (last === 'install_failed') throw new Error('Pterodactyl server installation failed.');
    } catch (e) {
      if (e.status && e.status >= 500) { /* keep polling */ }
      else if (e.status === 404) { /* server is not visible to client API yet */ }
      else if (e.message && /installation failed/i.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error(`Pterodactyl server did not become ready in time${last ? ` (state: ${last})` : ''}.`);
};

async function clientRaw(method, path, body, contentType = 'application/octet-stream') {
  return withRetry(async () => {
    const res = await fetch(`${base()}/api/client${path}`, {
      method,
      headers: { Authorization: `Bearer ${clientKey()}`, 'Content-Type': contentType, Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(120000)
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`Pterodactyl client ${res.status} ${method} ${path}: ${text.slice(0, 500)}`);
      err.status = res.status;
      err.retryAfter = res.headers.get('retry-after');
      throw err;
    }
    try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
  }, `${method} ${path.split('?')[0]}`);
}

// Read the admin ZIP and return clean entries (common top-level folder removed, unsafe paths skipped).
function readBotEntries(archiveBuffer) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archiveBuffer);
  const MAX_FILE = Number(process.env.BOT_MAX_FILE_MB || 25) * 1024 * 1024;
  const usable = zip.getEntries()
    .map((entry) => ({ entry, name: String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((x) => x.name);
  const firstParts = usable.map((x) => x.name.split('/').filter(Boolean)[0]).filter(Boolean);
  const uniqueFirst = [...new Set(firstParts)];
  const hasRootFile = usable.some((x) => !x.entry.isDirectory && x.name.split('/').filter(Boolean).length === 1);
  const commonRoot = uniqueFirst.length === 1 && !hasRootFile && usable.some((x) => x.name.includes('/')) ? uniqueFirst[0] : '';
  const files = [];
  for (const item of usable) {
    if (item.entry.isDirectory) continue;
    let name = item.name;
    if (commonRoot && name.startsWith(commonRoot + '/')) name = name.slice(commonRoot.length + 1);
    const parts = name.split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '..' || part === '.git')) continue;
    const data = item.entry.getData();
    if (data.length > MAX_FILE) throw new Error(`Bot file ${parts.join('/')} is larger than ${Math.round(MAX_FILE / 1024 / 1024)} MB.`);
    files.push({ path: parts.join('/'), data });
  }
  if (!files.length) throw new Error('The bot ZIP contains no usable files.');
  return files;
}

// FAST PATH (3-4 API calls in total, no matter how many files the bot has):
// upload one clean ZIP to the node, then ask the node to extract it.
async function uploadAndExtract(identifier, files, log) {
  const AdmZip = require('adm-zip');
  const out = new AdmZip();
  files.forEach((f) => out.addFile(f.path, f.data));
  const buf = out.toBuffer();
  await log([`Packing ${files.length} files (${Math.max(1, Math.round(buf.length / 1024))} KB)…`]);
  const signed = await clientApi('GET', `/servers/${identifier}/files/upload`);
  const url = signed && signed.attributes && signed.attributes.url;
  if (!url) throw new Error('No upload URL returned by the panel.');
  const form = new FormData();
  form.append('files', new Blob([buf], { type: 'application/zip' }), '_dvary_bot.zip');
  const res = await fetch(url + (url.includes('?') ? '&' : '?') + 'directory=' + encodeURIComponent('/'), { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Node upload failed (${res.status}).`);
  await log(['Uploaded to the server. Extracting…']);
  await clientApi('POST', `/servers/${identifier}/files/decompress`, { root: '/', file: '_dvary_bot.zip' });
  await log(files.map((f) => `✔ ${f.path}  (${f.data.length < 1024 ? f.data.length + ' B' : Math.round(f.data.length / 1024) + ' KB'})`));
  await clientApi('POST', `/servers/${identifier}/files/delete`, { root: '/', files: ['_dvary_bot.zip'] }).catch(() => {});
  return { files: files.length, mode: 'archive' };
}

// SLOW FALLBACK: write files one by one (already throttled + retried on 429).
async function writeOneByOne(identifier, files, log) {
  const dirs = new Set();
  files.forEach((f) => { let parent = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''; while (parent) { dirs.add(parent); parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : ''; } });
  const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const dir of sortedDirs) { await clientApi('POST', `/servers/${identifier}/files/create-folder`, { root: '/', name: dir }); await log([`📁 ${dir}/`]); }
  for (const file of files) { await clientRaw('POST', `/servers/${identifier}/files/write?file=${encodeURIComponent('/' + file.path)}`, file.data); await log([`✔ ${file.path}`]); }
  return { files: files.length, mode: 'files' };
}

exports.uploadArchive = async (identifier, archiveBuffer, onLog) => {
  const log = async (lines) => { if (onLog) { try { await onLog(lines); } catch (_) {} } };
  if (!exports.clientConfigured()) throw new Error('PTERODACTYL_CLIENT_API_KEY is required to upload bot files.');
  const files = readBotEntries(archiveBuffer);
  try {
    return await uploadAndExtract(identifier, files, log);
  } catch (e) {
    console.warn('[ptero] archive upload failed, using file-by-file fallback:', e.message);
    await log(['Fast upload not available, copying files one by one…']);
    return writeOneByOne(identifier, files, log);
  }
};

exports.uploadArchiveFile = async (identifier, archivePath, onLog) => {
  if (!archivePath) throw new Error('No bot ZIP archive is configured for this template.');
  const archiveBuffer = await fs.readFile(archivePath);
  return exports.uploadArchive(identifier, archiveBuffer, onLog);
};

const consoleCreds = async (identifier) => (await clientApi('GET', `/servers/${identifier}/websocket`)).data;

// Opens the Wings websocket of a server and forwards console output to the handlers.
exports.openConsole = async (identifier, h) => {
  const WebSocket = require('ws');
  let creds = await consoleCreds(identifier);
  const ws = new WebSocket(creds.socket, { headers: { Origin: base() } });
  let closed = false;
  const send = (event, args) => { if (ws.readyState === 1) ws.send(JSON.stringify({ event, args })); };
  ws.on('open', () => send('auth', [creds.token]));
  ws.on('message', async (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    const a = m.args || [];
    if (m.event === 'auth success') { send('send logs', [null]); send('send stats', [null]); h.onReady(); }
    else if (m.event === 'console output') h.onLine(String(a[0] || ''));
    else if (m.event === 'status') h.onStatus(String(a[0] || ''));
    else if (m.event === 'stats') { try { h.onStats(JSON.parse(a[0])); } catch (e) { /* ignore */ } }
    else if (m.event === 'token expiring') { try { creds = await consoleCreds(identifier); send('auth', [creds.token]); } catch (e) { h.onError(e.message); } }
    else if (m.event === 'token expired' || m.event === 'jwt error') h.onError('token ' + m.event);
    else if (m.event === 'daemon error') h.onLine('[daemon] ' + String(a[0] || ''));
  });
  ws.on('close', () => { if (!closed) h.onClose(); });
  ws.on('error', (e) => { if (!closed) h.onError(e.message); });
  return { close() { closed = true; try { ws.close(); } catch (e) { /* ignore */ } } };
};
