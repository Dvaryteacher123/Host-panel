// Small in-process queue: at most N bot deployments run at the same time, the rest wait their turn.
// The HTTP request returns immediately, so the website stays fast even when many people deploy together.
const MAX = Math.max(1, Number(process.env.MAX_CONCURRENT_DEPLOYS || 3));
let running = 0;
const waiting = [];

function pump() {
  while (running < MAX && waiting.length) {
    const job = waiting.shift();
    running++;
    Promise.resolve().then(job.fn).catch((e) => console.error('[deploy] unexpected job error', e && e.message)).finally(() => { running--; pump(); });
  }
}
exports.enqueue = (fn) => { waiting.push({ fn }); pump(); return waiting.length; };
exports.stats = () => ({ running, waiting: waiting.length, max: MAX });
