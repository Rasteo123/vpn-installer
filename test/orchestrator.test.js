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

test('an already-applied step is skipped (no execute/verify) but counts as completed', async () => {
  const order = [];
  const events = [];
  const orch = new Orchestrator((e) => events.push(e));
  const ctx = createInstallContext({});

  const applied = makeStep({
    id: 'a', target: 'vps',
    isApplied: async () => true,
    preflight: async () => order.push('a:preflight'),
    execute: async () => { throw new Error('execute must not run for an applied step'); },
    verify: async () => { throw new Error('verify must not run for an applied step'); },
  });

  const res = await orch.run([applied, fakeStep(order, 'b')], ctx);
  assert.deepStrictEqual(order, ['a:preflight', 'b:preflight', 'b:execute', 'b:verify']);
  assert.deepStrictEqual(res, { ok: true, completed: ['a', 'b'] });
  assert.ok(events.some((e) => e.type === 'step-skip' && e.stepId === 'a'));
});

const { SkippableError } = require('../src/main/steps/skippable');

// A step whose preflight declines: the install should carry on without it.
function skippingStep(id, reason, hooks = {}) {
  return makeStep({
    id,
    target: 'router',
    preflight: async () => { throw new SkippableError(reason); },
    execute: async () => { throw new Error(`${id} must never execute`); },
    ...hooks,
  });
}

test('a preflight SkippableError skips its step and lets the run continue', async () => {
  const events = [];
  const ran = [];
  const orch = new Orchestrator((e) => events.push(e));

  const steps = [
    makeStep({ id: 'a', target: 'vps', execute: async () => { ran.push('a'); } }),
    skippingStep('b', 'router is mips, no binary shipped'),
    makeStep({ id: 'c', target: 'vps', execute: async () => { ran.push('c'); } }),
  ];

  const result = await orch.run(steps, createInstallContext({}), {});

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(ran, ['a', 'c']);
  assert.deepStrictEqual(result.completed, ['a', 'c']);
  const skip = events.find((e) => e.type === 'step-skip' && e.stepId === 'b');
  assert.ok(skip, 'expected a step-skip event for b');
  assert.match(skip.reason, /mips/);
});

// A step that never ran owns no state, so rolling it back would be wrong.
test('a skipped step is not rolled back when a later step fails', async () => {
  const rolled = [];
  const orch = new Orchestrator(() => {});

  const steps = [
    skippingStep('b', 'not supported here', { rollback: async () => { rolled.push('b'); } }),
    makeStep({
      id: 'c',
      target: 'vps',
      execute: async () => { throw new Error('boom'); },
      rollback: async () => { rolled.push('c'); },
    }),
  ];

  const result = await orch.run(steps, createInstallContext({}), { rollbackOnFailure: true });

  assert.strictEqual(result.ok, false);
  assert.ok(!rolled.includes('b'), 'a step that never ran must not be rolled back');
});

test('preflightAll also honours SkippableError', async () => {
  const ran = [];
  const orch = new Orchestrator(() => {});
  const steps = [
    skippingStep('b', 'nope'),
    makeStep({ id: 'c', target: 'vps', execute: async () => { ran.push('c'); } }),
  ];

  const result = await orch.run(steps, createInstallContext({}), { preflightAll: true });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(ran, ['c']);
});

// Skipping is opt-in: an ordinary preflight failure must still stop everything.
test('a non-skippable preflight failure still fails the run', async () => {
  const orch = new Orchestrator(() => {});
  const steps = [makeStep({
    id: 'b',
    target: 'router',
    preflight: async () => { throw new Error('dnsmasq lacks nftset'); },
    execute: async () => {},
  })];
  const result = await orch.run(steps, createInstallContext({}), {});
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.failedStep, 'b');
});
