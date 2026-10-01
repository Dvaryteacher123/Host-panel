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

exports.panelUrl = (identifier) => `${base()}/server/${identifier}`;

async function api(method, path, body) {
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
  return { id, generatedPassword };
};

exports.createServer = async ({ pteroUserId, plan, bot, name, externalId }) => {
  const nestId = Number((bot && bot.nestId) || process.env.PTERODACTYL_NEST_ID);
  const eggId = Number((bot && bot.eggId) || process.env.PTERODACTYL_EGG_ID);
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
    docker_image: (bot && bot.dockerImage) || process.env.PTERODACTYL_DOCKER_IMAGE || eggAttr.docker_image,
    startup: (bot && bot.startup) || process.env.PTERODACTYL_STARTUP || eggAttr.startup,
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

async function clientApi(method, path, body) {
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
    throw err;
  }
  try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
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

exports.waitUntilReady = async (identifier, timeoutMs = 120000) => {
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
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Pterodactyl server did not become ready in time${last ? ` (state: ${last})` : ''}.`);
};

async function clientRaw(method, path, body, contentType = 'application/octet-stream') {
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
    throw err;
  }
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

// Upload an admin-managed bot ZIP archive into /home/container.
exports.uploadArchive = async (identifier, archiveBuffer) => {
  if (!exports.clientConfigured()) throw new Error('PTERODACTYL_CLIENT_API_KEY is required to upload bot files.');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archiveBuffer);
  const entries = zip.getEntries();
  const rootFiles = [];
  const dirs = new Set();
  const MAX_FILE = Number(process.env.BOT_MAX_FILE_MB || 25) * 1024 * 1024;

  const usable = entries
    .map((entry) => ({ entry, name: String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, '') }))
    .filter((x) => x.name);

  // If every ZIP entry is inside one common top-level directory, remove that
  // directory. Normal ZIPs with package.json/index.js at the root are kept intact.
  const firstParts = usable.map((x) => x.name.split('/').filter(Boolean)[0]).filter(Boolean);
  const uniqueFirst = [...new Set(firstParts)];
  const hasRootFile = usable.some((x) => !x.entry.isDirectory && x.name.split('/').filter(Boolean).length === 1);
  const commonRoot = uniqueFirst.length === 1 && !hasRootFile && usable.some((x) => x.name.includes('/'))
    ? uniqueFirst[0]
    : '';

  for (const item of usable) {
    const entry = item.entry;
    let name = item.name;
    if (commonRoot && name === commonRoot) continue;
    if (commonRoot && name.startsWith(commonRoot + '/')) name = name.slice(commonRoot.length + 1);

    const parts = name.split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '..' || part === '.git')) continue;
    const clean = parts.join('/');

    if (entry.isDirectory) {
      dirs.add(clean.replace(/\/+$/, ''));
      continue;
    }

    const data = entry.getData();
    if (data.length > MAX_FILE) throw new Error(`Bot file ${clean} is larger than ${Math.round(MAX_FILE / 1024 / 1024)} MB.`);
    rootFiles.push({ path: clean, data });

    let parent = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
    while (parent) {
      dirs.add(parent);
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
    }
  }

  if (!rootFiles.length) throw new Error('The bot ZIP contains no usable files.');

  const sortedDirs = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
  for (const dir of sortedDirs) {
    await clientApi('POST', `/servers/${identifier}/files/create-folder`, { root: '/', name: dir });
  }
  for (const file of rootFiles) {
    const query = `?file=${encodeURIComponent('/' + file.path)}`;
    await clientRaw('POST', `/servers/${identifier}/files/write${query}`, file.data);
  }
  return { files: rootFiles.length, directories: sortedDirs.length };
};

exports.uploadArchiveFile = async (identifier, archivePath) => {
  if (!archivePath) throw new Error('No bot ZIP archive is configured for this template.');
  const archiveBuffer = await fs.readFile(archivePath);
  return exports.uploadArchive(identifier, archiveBuffer);
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
