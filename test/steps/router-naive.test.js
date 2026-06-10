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
