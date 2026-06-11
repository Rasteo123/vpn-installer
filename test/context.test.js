const test = require('node:test');
const assert = require('node:assert');
const { createInstallContext } = require('../src/main/context');

test('builds context with defaults and supplied inputs', () => {
  const ctx = createInstallContext({
    vps: { host: '198.51.100.7', auth: 'key', privateKey: 'KEY' },
    router: { host: '192.0.2.1', password: 'p' },
    protocols: { naive: true },
    naiveDomain: 'ex.mywire.org',
  });
  assert.strictEqual(ctx.inputs.vps.port, 22);
  assert.strictEqual(ctx.inputs.vps.username, 'root');
  assert.strictEqual(ctx.inputs.protocols.awg, true);
  assert.strictEqual(ctx.inputs.protocols.naive, true);
  assert.strictEqual(ctx.inputs.naiveDomain, 'ex.mywire.org');
  assert.deepStrictEqual(ctx.results, {});
  assert.deepStrictEqual(ctx.backup, {});
});

test('rejects hosts and domains that could smuggle shell into root commands', () => {
  assert.throws(() => createInstallContext({ vps: { host: '1.2.3.4; reboot' } }), /host/i);
  assert.throws(() => createInstallContext({ router: { host: '192.168.1.1`id`' } }), /host/i);
  assert.throws(
    () => createInstallContext({ vps: { host: '198.51.100.7' }, naiveDomain: 'ex.com$(x)' }),
    /домен|domain/i,
  );
  assert.throws(() => createInstallContext({ vps: { host: '198.51.100.7', port: '99999' } }), /port/i);
});

test('omitted host/domain stay undefined (router-only phase context)', () => {
  const ctx = createInstallContext({});
  assert.strictEqual(ctx.inputs.vps.host, undefined);
  assert.strictEqual(ctx.inputs.naiveDomain, undefined);
});
