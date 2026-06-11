const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerNaive } = require('../../src/main/steps/router-naive');

test('router.naive writes client config, init, tun_naive iface and naive_fwd zone', async () => {
  const s = new FakeSSHSession({ 'command -v sing-box': { code: 0, stdout: '/usr/bin/sing-box' } });
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' }, naiveDomain: 'ex.org' });
  ctx.sessions.router = s;
  ctx.results.naive = { domain: 'ex.org', username: 'u', password: 'p', port: 2053 };

  await routerNaive.preflight(ctx);
  await routerNaive.execute(ctx);

  assert.match(s.written['/etc/sing-box/naive-client.json'], /"server": "203\.0\.113\.9"/);
  assert.match(s.written['/etc/sing-box/naive-client.json'], /"server_name": "ex\.org"/);
  assert.ok(s.execed.some((c) => c.includes('network.tun_naive=interface')));
  assert.ok(s.execed.some((c) => c.includes("name='naive_fwd'")));
});

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' }, naiveDomain: 'ex.org' });
  ctx.sessions.router = s;
  ctx.results.naive = { domain: 'ex.org', username: 'u', password: 'p', port: 2053 };
  return ctx;
}

test('router.naive writes the client config (with the proxy password) as 0600', async () => {
  const s = new FakeSSHSession({ 'command -v sing-box': { code: 0, stdout: '/usr/bin/sing-box' } });
  const ctx = makeCtx(s);
  await routerNaive.execute(ctx);
  assert.strictEqual(s.modes['/etc/sing-box/naive-client.json'], 0o600);
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
