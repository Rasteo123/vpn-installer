const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerNaive, versionAtLeast, ensureSingBox } = require('../../src/main/steps/router-naive');

const READY_SING_BOX = {
  'sing-box version': { stdout: 'sing-box version 1.13.12\n' },
  'opkg list-installed': { stdout: 'yes\n' },
};

test('router.naive writes client config, init, tun_naive iface and naive_fwd zone', async () => {
  const s = new FakeSSHSession(READY_SING_BOX);
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' }, naiveDomain: 'ex.org' });
  ctx.sessions.router = s;
  ctx.results.naive = { domain: 'ex.org', username: 'u', password: 'p', port: 443 };

  await routerNaive.preflight(ctx);
  await routerNaive.execute(ctx);

  assert.match(s.written['/etc/sing-box/naive-client.json'], /"server": "203\.0\.113\.9"/);
  assert.match(s.written['/etc/sing-box/naive-client.json'], /"server_name": "ex\.org"/);
  assert.match(s.written['/etc/sing-box/naive-client.json'], /"server_port": 443/);
  assert.ok(s.execed.some((c) => c.includes('network.tun_naive=interface')));
  assert.ok(s.execed.some((c) => c.includes("name='naive_fwd'")));
});

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' }, naiveDomain: 'ex.org' });
  ctx.sessions.router = s;
  ctx.results.naive = { domain: 'ex.org', username: 'u', password: 'p', port: 443 };
  return ctx;
}

// sing-box needs a moment to create the tun after the initd restart — verify
// must poll instead of taking one fixed-delay sample.
test('router.naive verify waits for the process and the tun to come up', async () => {
  const s = new FakeSSHSession({
    ...READY_SING_BOX,
    'pgrep -f naive-client.json': { stdout: '1234\n' },
    'ip link show tun-naive': { code: 0 },
  });
  s.respondOnce('pgrep -f naive-client.json', { stdout: '' });
  const ctx = makeCtx(s);
  ctx.timing = { pollIntervalMs: 5, pollTimeoutMs: 200 };
  await routerNaive.verify(ctx); // must not throw
});

test('router.naive writes the client config (with the proxy password) as 0600', async () => {
  const s = new FakeSSHSession(READY_SING_BOX);
  const ctx = makeCtx(s);
  await routerNaive.execute(ctx);
  assert.strictEqual(s.modes['/etc/sing-box/naive-client.json'], 0o600);
});

test('router.naive enforces the sing-box version containing the Naive fixes', async () => {
  assert.strictEqual(versionAtLeast('1.13.12', '1.13.12'), true);
  assert.strictEqual(versionAtLeast('1.14.0', '1.13.12'), true);
  assert.strictEqual(versionAtLeast('1.13.11', '1.13.12'), false);

  class UpgradeSession extends FakeSSHSession {
    constructor() {
      super({ 'opkg list-installed': { stdout: 'yes\n' } });
      this.versionCalls = 0;
    }

    async exec(command) {
      if (command.includes('sing-box version')) {
        this.execed.push(command);
        this.versionCalls += 1;
        const version = this.versionCalls < 3 ? '1.13.11' : '1.13.12';
        return { stdout: `sing-box version ${version}\n`, stderr: '', code: 0 };
      }
      return super.exec(command);
    }
  }

  const s = new UpgradeSession();
  await ensureSingBox(s, () => {});
  const official = s.execed.find((c) => c.includes('github.com/SagerNet/sing-box/releases'));
  assert.ok(official, 'uses the official OpenWrt package when the feed is stale');
  assert.match(official, /v1\.13\.12/);
  assert.match(official, /opkg print-architecture/);
});

test('router.naive rollback removes the naive_fwd zone and its forwarding, then commits firewall', async () => {
  const s = new FakeSSHSession();
  const ctx = makeCtx(s);
  await routerNaive.rollback(ctx);
  const joined = s.execed.join('\n');
  assert.match(joined, /naive_fwd/);
  // both the zone and the lan->naive_fwd forwarding must be torn down
  assert.ok(s.execed.some((c) => /zone/.test(c) && c.includes('naive_fwd')), 'remove naive_fwd zone');
  assert.ok(s.execed.some((c) => /forwarding/.test(c) && c.includes('naive_fwd')), 'remove naive_fwd forwarding');
  assert.ok(s.execed.some((c) => c.includes('uci commit firewall')));
});
