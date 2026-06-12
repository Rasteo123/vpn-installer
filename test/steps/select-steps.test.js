const test = require('node:test');
const assert = require('node:assert');
const { createInstallContext } = require('../../src/main/context');
const { serverStepsFor, routerStepsFor } = require('../../src/main/steps/select-steps');
const { serverAwg } = require('../../src/main/steps/server-awg');
const { serverNaive } = require('../../src/main/steps/server-naive');
const { adoptServerAwg, adoptServerNaive } = require('../../src/main/steps/server-adopt');

function ctxWith({ naiveDomain, naive } = {}) {
  return createInstallContext({
    vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' },
    naiveDomain,
    protocols: { naive: naive !== undefined ? naive : !!naiveDomain },
  });
}

test('serverStepsFor: fresh VPS installs awg, plus naive only when enabled', () => {
  assert.deepStrictEqual(serverStepsFor(ctxWith({ naive: false })), [serverAwg]);
  assert.deepStrictEqual(serverStepsFor(ctxWith({ naiveDomain: 'ex.org' })), [serverAwg, serverNaive]);
});

test('serverStepsFor: existing deployment is adopted instead of reinstalled', () => {
  const both = serverStepsFor(ctxWith({ naive: false }), { awg: true, naive: true });
  assert.deepStrictEqual(both, [adoptServerAwg, adoptServerNaive]);
  // existing naive is adopted even when the user did not ask for naive —
  // it costs nothing (read-only) and gives the router its fallback
  assert.strictEqual(both[1], adoptServerNaive);
});

test('serverStepsFor: mixed case — adopt awg, fresh-install naive when domain given', () => {
  const steps = serverStepsFor(ctxWith({ naiveDomain: 'ex.org' }), { awg: true, naive: false });
  assert.deepStrictEqual(steps, [adoptServerAwg, serverNaive]);
});

test('routerStepsFor: includes router.naive only when server naive results exist', () => {
  const withNaive = ctxWith({ naiveDomain: 'ex.org' });
  withNaive.results.naive = { domain: 'ex.org', username: 'u', password: 'p', port: 2053 };
  assert.deepStrictEqual(
    routerStepsFor(withNaive).map((s) => s.id),
    ['router.backup', 'router.awg', 'router.naive', 'router.pbr', 'router.failover', 'router.verify']
  );

  // server installed without a domain -> no naive results -> the step is not planned at all
  const without = ctxWith({ naive: false });
  assert.deepStrictEqual(
    routerStepsFor(without).map((s) => s.id),
    ['router.backup', 'router.awg', 'router.pbr', 'router.failover', 'router.verify']
  );
});
