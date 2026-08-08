// Runs the router steps and, on any failure, restores the router from the
// pre-change uci backup. Returns a structured result so callers can tell the
// user the TRUTH about whether the restore actually succeeded.
//   { ok: true,  restored: null }                        — install succeeded
//   { ok: false, restored: null, untouched: true, error } — failed before any change
//   { ok: false, restored: true,  error }                — failed, restore ok
//   { ok: false, restored: false, error, restoreError }  — failed, restore failed
async function runRouterSteps(orch, steps, ctx, { restoreRouter, opts } = {}) {
  const res = await orch.run(steps, ctx, opts || { preflightAll: true, rollbackOnFailure: true });
  if (res.ok) return { ok: true, restored: null };
  // A preflight failure — or any failure before the backup was captured —
  // means the router was never modified; "restoring" would only restart its
  // network and firewall for nothing.
  if (res.phase === 'preflight' || !ctx.backup || !ctx.backup.network) {
    return { ok: false, restored: null, untouched: true, error: res.error };
  }
  try {
    await restoreRouter(ctx);
    return { ok: false, restored: true, error: res.error };
  } catch (e) {
    return { ok: false, restored: false, error: res.error, restoreError: e.message };
  }
}

module.exports = { runRouterSteps };
