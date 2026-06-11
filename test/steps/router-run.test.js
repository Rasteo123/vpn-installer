const test = require('node:test');
const assert = require('node:assert');
const { runRouterSteps } = require('../../src/main/steps/router-run');

function fakeOrch(result) {
  return { run: async () => result };
}

test('success: no restore attempted, restored is null', async () => {
  let restoreCalled = false;
  const out = await runRouterSteps(fakeOrch({ ok: true, completed: ['a'] }), [], {}, {
    restoreRouter: async () => { restoreCalled = true; },
  });
  assert.deepStrictEqual(out, { ok: true, restored: null });
  assert.strictEqual(restoreCalled, false);
});

test('failure + successful restore: restored true, original error preserved', async () => {
  const err = new Error('router.pbr boom');
  const out = await runRouterSteps(fakeOrch({ ok: false, error: err, failedStep: 'router.pbr' }), [], {}, {
    restoreRouter: async () => {},
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, true);
  assert.strictEqual(out.error, err);
});

test('failure + failed restore: restored false and the restore error is reported', async () => {
  const out = await runRouterSteps(fakeOrch({ ok: false, error: new Error('x'), failedStep: 'router.awg' }), [], {}, {
    restoreRouter: async () => { throw new Error('uci import died'); },
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.restored, false);
  assert.match(out.restoreError, /uci import died/);
});
