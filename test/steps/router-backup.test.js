const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerBackup, restoreRouter } = require('../../src/main/steps/router-backup');

function ctxWith(session) {
  const c = createInstallContext({});
  c.sessions.router = session;
  return c;
}

test('router.backup captures all three uci packages', async () => {
  const s = new FakeSSHSession({
    'uci export network': { stdout: 'NETCFG' },
    'uci export firewall': { stdout: 'FWCFG' },
    'uci export pbr': { stdout: 'PBRCFG' },
  });
  const ctx = ctxWith(s);
  await routerBackup.execute(ctx);
  assert.strictEqual(ctx.backup.network, 'NETCFG');
  assert.strictEqual(ctx.backup.firewall, 'FWCFG');
  assert.strictEqual(ctx.backup.pbr, 'PBRCFG');
  await routerBackup.verify(ctx); // should not throw
});

test('restoreRouter imports packages and restarts network/firewall', async () => {
  const s = new FakeSSHSession();
  const ctx = ctxWith(s);
  ctx.backup = { network: 'N', firewall: 'F', pbr: 'P' };
  await restoreRouter(ctx);
  assert.ok(s.execed.some((c) => c.includes('uci import network')));
  assert.ok(s.execed.some((c) => c.includes('uci import firewall')));
  assert.ok(s.execed.some((c) => c.includes('/etc/init.d/network restart')));
  assert.ok(s.execed.some((c) => c.includes('/etc/init.d/firewall restart')));
});
