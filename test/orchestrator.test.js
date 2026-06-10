const test = require('node:test');
const assert = require('node:assert');
const { makeStep } = require('../src/main/steps/step');
const { Orchestrator } = require('../src/main/orchestrator');
const { createInstallContext } = require('../src/main/context');

test('makeStep fills optional hooks with no-ops', async () => {
  const s = makeStep({ id: 'x', target: 'vps', execute: async () => {} });
  assert.strictEqual(s.id, 'x');
  assert.strictEqual(s.title, 'x');
  assert.strictEqual(typeof s.preflight, 'function');
  assert.strictEqual(typeof s.verify, 'function');
  assert.strictEqual(typeof s.rollback, 'function');
  assert.strictEqual(await s.isApplied({}), false);
});

// Fake step that records its phase calls into a shared `order` array.
// hooks: set a phase to false to make it throw.
function fakeStep(order, id, hooks = {}) {
  return makeStep({
    id, target: 'vps',
    preflight: async () => { order.push(`${id}:preflight`); if (hooks.preflight === false) throw new Error(`${id} preflight`); },
    execute: async (ctx) => { order.push(`${id}:execute`); ctx.results[id] = 'done'; if (hooks.execute === false) throw new Error(`${id} execute`); },
    verify: async () => { order.push(`${id}:verify`); if (hooks.verify === false) throw new Error(`${id} verify`); },
    rollback: async (ctx) => { order.push(`${id}:rollback`); delete ctx.results[id]; },
  });
}

test('runs steps in order through all phases and reports success', async () => {
  const order = [];
  const events = [];
  const orch = new Orchestrator((e) => events.push(e));
  const ctx = createInstallContext({});
  const res = await orch.run([fakeStep(order, 'a'), fakeStep(order, 'b')], ctx);

  assert.deepStrictEqual(order, [
    'a:preflight', 'a:execute', 'a:verify',
    'b:preflight', 'b:execute', 'b:verify',
  ]);
  assert.deepStrictEqual(res, { ok: true, completed: ['a', 'b'] });
  assert.deepStrictEqual(ctx.results, { a: 'done', b: 'done' });
  assert.ok(events.some((e) => e.type === 'step-done' && e.stepId === 'b'));
});

test('preflightAll stops before any execute when a preflight fails', async () => {
  const order = [];
  const orch = new Orchestrator();
  const ctx = createInstallContext({});
  const res = await orch.run(
    [fakeStep(order, 'a'), fakeStep(order, 'b', { preflight: false })],
    ctx,
    { preflightAll: true },
  );
  assert.deepStrictEqual(order, ['a:preflight', 'b:preflight']);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.failedStep, 'b');
  assert.deepStrictEqual(ctx.results, {});
});

test('rolls back the failed step then completed steps in reverse on execute failure', async () => {
  const order = [];
  const orch = new Orchestrator();
  const ctx = createInstallContext({});
  const res = await orch.run(
    [fakeStep(order, 'a'), fakeStep(order, 'b', { execute: false })],
    ctx,
    { rollbackOnFailure: true },
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.failedStep, 'b');
  assert.deepStrictEqual(order, [
    'a:preflight', 'a:execute', 'a:verify',
    'b:preflight', 'b:execute',
    'b:rollback', 'a:rollback',
  ]);
  assert.deepStrictEqual(ctx.results, {});
});

test('verify failure triggers rollback of that step', async () => {
  const order = [];
  const orch = new Orchestrator();
  const ctx = createInstallContext({});
  const res = await orch.run([fakeStep(order, 'a', { verify: false })], ctx, { rollbackOnFailure: true });
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(order, ['a:preflight', 'a:execute', 'a:verify', 'a:rollback']);
});
