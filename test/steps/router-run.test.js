const test = require('node:test');
const assert = require('node:assert');
const { runRouterSteps } = require('../../src/main/steps/router-run');

function fakeOrch(result) {
  return { run: async () => result };
}

// A ctx whose backup was captured — the normal state when a step fails mid-run.
function backedUpCtx() {
  return { backup: { network: "config interface 'lan'" } };
}

test('success: no restore attempted, restored is null', async () => {
  let restoreCalled = false;
  const out = await runRouterSteps(fakeOrch({ ok: true, completed: ['a'] }), [], backedUpCtx(), {
    restoreRouter: async () => { restoreCalled = true; },
  });
  assert.deepStrictEqual(out, { ok: true, restored: null });
  assert.strictEqual(restoreCalled, false);
});

test('failure + successful restore: restored true, original error preserved', async () => {
  const err = new Error('router.pbr boom');
  const out = await runRouterSteps(fakeOrch({ ok: false, error: err, failedStep: 'router.pbr' }), [], backedUpCtx(), {
    restoreRouter: async () => {},
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, true);
  assert.strictEqual(out.error, err);
});

test('failure + failed restore: restored false and the restore error is reported', async () => {
  const out = await runRouterSteps(fakeOrch({ ok: false, error: new Error('x'), failedStep: 'router.awg' }), [], backedUpCtx(), {
    restoreRouter: async () => { throw new Error('uci import died'); },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, false);
  assert.match(out.restoreError, /uci import died/);
});

// A preflight failure means nothing was changed yet — restoring would only
// restart the router's network for no reason.
test('preflight failure: router untouched, restore not attempted', async () => {
  let restoreCalled = false;
  const err = new Error('router.awg: missing server AWG results');
  const out = await runRouterSteps(
    fakeOrch({ ok: false, error: err, failedStep: 'router.awg', phase: 'preflight' }),
    [], backedUpCtx(),
    { restoreRouter: async () => { restoreCalled = true; } },
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, null);
  assert.strictEqual(out.untouched, true);
  assert.strictEqual(out.error, err);
  assert.strictEqual(restoreCalled, false);
});

test('failure before the backup was captured: restore not attempted', async () => {
  let restoreCalled = false;
  const out = await runRouterSteps(
    fakeOrch({ ok: false, error: new Error('backup died'), failedStep: 'router.backup' }),
    [], { backup: {} },
    { restoreRouter: async () => { restoreCalled = true; } },
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, null);
  assert.strictEqual(out.untouched, true);
  assert.strictEqual(restoreCalled, false);
});
