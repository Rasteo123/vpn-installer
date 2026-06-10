const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerAwg } = require('../../src/main/steps/router-awg');

function makeCtx(session) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.router = session;
  ctx.results.awg = {
    clientPrivateKey: 'CK', clientAddress: '10.66.66.2/32',
    obfuscation: { jc: 6, jmin: 48, jmax: 96, s1: 64, s2: 132, s3: 196, s4: 88, h1: 'a', h2: 'b', h3: 'c', h4: 'd', i1: 'I' },
    serverPublicKey: 'SK', presharedKey: 'PSK', listenPort: 443,
  };
  return ctx;
}

test('router.awg preflight detects the WAN gateway', async () => {
  const s = new FakeSSHSession({
    'command -v uci': { code: 0, stdout: '/sbin/uci' },
    'ip route show default': { stdout: 'default via 192.0.2.1 dev eth1' },
  });
  const ctx = makeCtx(s);
  await routerAwg.preflight(ctx);
  assert.strictEqual(ctx.results.detected.routerWanGw, '192.0.2.1');
});

test('router.awg writes the awg uci batch (endpoint route) and adds awg0 to wan', async () => {
  const s = new FakeSSHSession({
    'command -v uci': { code: 0, stdout: '/sbin/uci' },
    'ip route show default': { stdout: 'default via 192.0.2.1 dev eth1' },
    'command -v awg': { code: 0, stdout: '/usr/bin/awg' },
  });
  const ctx = makeCtx(s);
  await routerAwg.preflight(ctx);
  await routerAwg.execute(ctx);

  const batch = s.written['/tmp/awg.uci'];
  assert.match(batch, /set network\.awg0\.proto='amneziawg'/);
  assert.match(batch, /\.endpoint_host='203\.0\.113\.9'/);
  assert.match(batch, /set network\.@route\[-1\]\.target='203\.0\.113\.9'/);
  assert.match(batch, /set network\.@route\[-1\]\.gateway='192\.0\.2\.1'/);
  assert.ok(s.execed.some((c) => c.includes('uci batch < /tmp/awg.uci')));
  assert.ok(s.execed.some((c) => c.includes('add_list') && c.includes('awg0')));
  assert.ok(s.execed.some((c) => c.includes('/etc/init.d/network restart')));
});
