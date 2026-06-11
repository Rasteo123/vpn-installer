// Runs the router steps and, on any failure, restores the router from the
// pre-change uci backup. Returns a structured result so callers can tell the
// user the TRUTH about whether the restore actually succeeded.
//   { ok: true,  restored: null }                       — install succeeded
//   { ok: false, restored: true,  error }               — failed, restore ok
//   { ok: false, restored: false, error, restoreError } — failed, restore failed
async function runRouterSteps(orch, steps, ctx, { restoreRouter, opts } = {}) {
  const res = await orch.run(steps, ctx, opts || { preflightAll: true, rollbackOnFailure: true });
  if (res.ok) return { ok: true, restored: null };
  try {
    await restoreRouter(ctx);
    return { ok: false, restored: true, error: res.error };
  } catch (e) {
    return { ok: false, restored: false, error: res.error, restoreError: e.message };
  }
}

module.exports = { runRouterSteps };
