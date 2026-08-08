// Poll an async check until it passes or the timeout elapses. Returns whether
// it ever passed; the caller owns the diagnostic error. Steps take intervals
// from ctx.timing so tests can run the same code paths in milliseconds.
async function waitFor(check, { timeoutMs = 30000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { waitFor };
