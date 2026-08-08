const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerFailover } = require('../../src/main/steps/router-failover');

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.router = s;
  ctx.timing = { pollIntervalMs: 5, pollTimeoutMs: 200 };
  return ctx;
}

test('router.failover deploys conf, script and initd, then enables the daemon', async () => {
  const s = new FakeSSHSession();
  await routerFailover.execute(makeCtx(s));
  assert.ok(s.written['/etc/vpn-failover.conf']);
  assert.ok(s.written['/usr/bin/vpn-failover.sh']);
  assert.ok(s.written['/etc/init.d/vpn-failover']);
  assert.ok(s.execed.some((c) => c.includes('chmod +x /usr/bin/vpn-failover.sh')));
  assert.ok(s.execed.some((c) => c.includes('/etc/init.d/vpn-failover enable')));
});

// The daemon probes both tunnels before writing its first state — verify must
// poll for the state file instead of taking one fixed-delay sample.
test('router.failover verify waits for the daemon to choose a route state', async () => {
  const s = new FakeSSHSession({
    'pgrep -f vpn-failover.sh': { stdout: '321\n' },
    'cat /var/run/vpn-failover.state': { stdout: 'awg\n' },
  });
  s.respondOnce('cat /var/run/vpn-failover.state', { stdout: '' });
  s.respondOnce('cat /var/run/vpn-failover.state', { stdout: '' });
  await routerFailover.verify(makeCtx(s)); // must not throw
});

test('router.failover verify rejects when no valid state ever appears', async () => {
  const s = new FakeSSHSession({
    'pgrep -f vpn-failover.sh': { stdout: '321\n' },
    'cat /var/run/vpn-failover.state': { stdout: '' },
  });
  const ctx = makeCtx(s);
  ctx.timing = { pollIntervalMs: 5, pollTimeoutMs: 30 };
  await assert.rejects(() => routerFailover.verify(ctx), /route state/);
});
