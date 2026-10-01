const crypto = require('crypto');
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
    const err = new Error(`Pterodactyl ${res.status} ${method} ${path}: ${text.slice(0, 600)}`);
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

// Make sure a Pterodactyl user with this email exists. Returns the Pterodactyl user id.
exports.ensureUser = async (user) => {
  if (user.pteroUserId) return user.pteroUserId;
  const email = user.email.toLowerCase();
  const found = await api('GET', `/users?filter[email]=${encodeURIComponent(email)}`);
  const match = ((found && found.data) || []).find((u) => u.attributes.email.toLowerCase() === email);
  let id;
  if (match) {
    id = match.attributes.id;
  } else {
    const parts = user.name.trim().split(/\s+/);
    const created = await api('POST', '/users', {
      email, username: makeUsername(email),
      first_name: (parts[0] || 'User').slice(0, 50), last_name: (parts.slice(1).join(' ') || 'Dvary').slice(0, 50),
      // random password, never stored: the customer uses "Forgot password" on the panel
      password: crypto.randomBytes(18).toString('base64url') + 'aA1'
    });
    id = created.attributes.id;
  }
  await User.updateOne({ _id: user._id }, { $set: { pteroUserId: id } });
  return id;
};

const GIT_ADDR_KEYS = ['GIT_ADDRESS', 'GITHUB_URL', 'GIT_REPO', 'REPO_URL', 'REPO'];
const GIT_BRANCH_KEYS = ['BRANCH', 'GIT_BRANCH'];

// Create a server on the panel. Returns { id, identifier, uuid }.
exports.createServer = async ({ pteroUserId, plan, bot, name, externalId }) => {
  const nestId = Number(process.env.PTERODACTYL_NEST_ID);
  const eggId = Number((bot && bot.eggId) || process.env.PTERODACTYL_EGG_ID);
  const locationId = Number(process.env.PTERODACTYL_LOCATION_ID);
  if (!nestId || !eggId || !locationId) throw new Error('PTERODACTYL_NEST_ID / EGG_ID / LOCATION_ID are not configured');

  const egg = await api('GET', `/nests/${nestId}/eggs/${eggId}?include=variables`);
  const eggAttr = egg.attributes;
  const environment = {};
  (((eggAttr.relationships || {}).variables || {}).data || []).forEach((v) => {
    environment[v.attributes.env_variable] = v.attributes.default_value;
  });
  const eggVars = new Set(Object.keys(environment));

  // Git deploy: the repo URL set by the admin is passed to the egg's own git variables.
  // The egg itself (e.g. a Git-enabled Node.js egg) performs the clone/install/start.
  if (bot && bot.gitUrl) {
    const explicit = Object.keys(bot.environment || {});
    const addrKey = GIT_ADDR_KEYS.find((k) => eggVars.has(k));
    if (!addrKey && !explicit.some((k) => GIT_ADDR_KEYS.includes(k))) {
      throw new Error(`Egg ${eggId} has no Git variable (${GIT_ADDR_KEYS.join('/')}). Use a git-capable egg for template "${bot.name}".`);
    }
    if (addrKey) environment[addrKey] = bot.gitUrl;
    const branchKey = GIT_BRANCH_KEYS.find((k) => eggVars.has(k));
    if (branchKey) environment[branchKey] = bot.gitBranch || 'main';
    if (eggVars.has('AUTO_UPDATE')) environment.AUTO_UPDATE = '1';
    if (eggVars.has('USER_UPLOAD')) environment.USER_UPLOAD = '0';
  }
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
    start_on_completion: true
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

exports.suspendServer = (pteroId) => api('POST', `/servers/${pteroId}/suspend`);
exports.unsuspendServer = (pteroId) => api('POST', `/servers/${pteroId}/unsuspend`);
exports.deleteServer = (pteroId) => api('DELETE', `/servers/${pteroId}`);
