// Realtime push for private chat using Server-Sent Events (no new dependency).
// Each logged-in browser tab opens /…/chat/stream; when a message is stored we push a tiny
// "ping" to the two participants only, and their page fetches the new messages immediately.
const clients = new Map(); // userId -> Set<res>

exports.add = (uid, res) => {
  uid = String(uid);
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
  res.on('close', () => {
    const set = clients.get(uid);
    if (set) { set.delete(res); if (!set.size) clients.delete(uid); }
  });
};

exports.push = (uid, event) => {
  const set = clients.get(String(uid));
  if (!set) return;
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const res of set) {
    try { res.write(payload); if (typeof res.flush === 'function') res.flush(); } catch (_) {}
  }
};

// open SSE response with correct headers
exports.open = (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  if (typeof res.flush === 'function') res.flush();
  const beat = setInterval(() => { try { res.write(': hb\n\n'); if (typeof res.flush === 'function') res.flush(); } catch (_) {} }, 25000);
  res.on('close', () => clearInterval(beat));
};
