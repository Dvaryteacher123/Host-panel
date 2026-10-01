const crypto = require('crypto');

const API = 'https://api.github.com';
const encKey = () => String(process.env.GITHUB_TOKEN_ENCRYPTION_KEY || '');

function headers(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'Dvary-Host'
  };
}

async function githubFetch(path, token, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { ...headers(token), ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!res.ok) {
    const msg = data?.message || text.slice(0, 300) || `GitHub HTTP ${res.status}`;
    const err = new Error(`GitHub ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function requireKey() {
  const key = encKey();
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY must be 32 random bytes in hex (64 characters).');
  return Buffer.from(key, 'hex');
}

exports.encryptToken = (token) => {
  const key = requireKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
};

exports.decryptToken = (value) => {
  const key = requireKey();
  const [ivRaw, tagRaw, encryptedRaw] = String(value || '').split('.');
  if (!ivRaw || !tagRaw || !encryptedRaw) throw new Error('Invalid GitHub token storage.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64url')), decipher.final()]).toString('utf8');
};

exports.exchangeCode = async (code) => {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Dvary-Host' },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code
    }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await res.json();
  if (!res.ok || data.error || !data.access_token) throw new Error(data.error_description || data.error || 'GitHub authorization failed.');
  return data.access_token;
};

exports.getUser = (token) => githubFetch('/user', token);
exports.getEmails = (token) => githubFetch('/user/emails', token);
exports.getRepos = async (token) => {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const rows = await githubFetch(`/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`, token);
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: !!r.private,
    defaultBranch: r.default_branch || 'main',
    description: r.description || '',
    htmlUrl: r.html_url,
    updatedAt: r.updated_at,
    owner: r.owner?.login || ''
  }));
};

exports.getArchive = async (token, fullName, branch) => {
  if (!/^[^/]+\/[^/]+$/.test(fullName)) throw new Error('Invalid GitHub repository.');
  const ref = encodeURIComponent(branch || 'main');
  const res = await fetch(`${API}/repos/${fullName}/zipball/${ref}`, {
    headers: { ...headers(token), Accept: 'application/vnd.github+json' },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch (_) {}
    throw new Error(`Could not download repository: ${msg.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const max = Number(process.env.GITHUB_MAX_ARCHIVE_MB || 100) * 1024 * 1024;
  if (buf.length > max) throw new Error(`Repository archive is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  return buf;
};
