const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { serverAwg } = require('../../src/main/steps/server-awg');

const CONF = '/etc/amnezia/amneziawg/awg0.conf';
const KEYGEN_OUT = 'SPRIV\nSPUB\nCPRIV\nCPUB\nPSK\n';

function ctxWith(responses) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.vps = new FakeSSHSession(responses);
  ctx.results.detected = { wanIface: 'eth0' };
  return ctx;
}

const BASE = {
  '# awg-keygen': { stdout: KEYGEN_OUT },
  'ufw status': { stdout: 'Status: inactive\n' },
};

test('server.awg recovers a half-configured dpkg before installing', async () => {
  const ctx = ctxWith(BASE);
  await serverAwg.execute(ctx);
  const s = ctx.sessions.vps;
  const dpkgIdx = s.execed.findIndex((c) => c.includes('dpkg --configure -a'));
  const aptIdx = s.execed.findIndex((c) => c.includes('apt-get install -y amneziawg'));
  assert.ok(dpkgIdx !== -1, 'dpkg --configure -a should run');
  assert.ok(dpkgIdx < aptIdx, 'dpkg recovery must precede the package install');
});

test('server.awg generates keys without ever putting them in a command argument', async () => {
  const ctx = ctxWith(BASE);
  await serverAwg.execute(ctx);
  const s = ctx.sessions.vps;
  // Keys must come from a single server-side script that keeps them in shell
  // variables — not interpolated into argv (which `ps` would expose).
  assert.ok(s.execed.some((c) => c.includes('# awg-keygen') && c.includes('$(awg genkey)')));
  for (const c of s.execed) {
    assert.ok(!/\bawg pubkey/.test(c) || /\$\(.*awg pubkey|awg pubkey/.test(c), c);
    assert.ok(!c.includes("echo 'SPRIV'"), 'private key must not be echoed as a literal');
  }
  assert.deepStrictEqual(
    [ctx.results.awg.serverPublicKey, ctx.results.awg.clientPrivateKey, ctx.results.awg.presharedKey],
    ['SPUB', 'CPRIV', 'PSK'],
  );
});

test('server.awg writes the config with 0600 permissions', async () => {
  const ctx = ctxWith(BASE);
  await serverAwg.execute(ctx);
  assert.strictEqual(ctx.sessions.vps.modes[CONF], 0o600);
});

test('server.awg opens udp/443 when ufw is active, and rollback closes it', async () => {
  const ctx = ctxWith({ ...BASE, 'ufw status': { stdout: 'Status: active\n' } });
  await serverAwg.execute(ctx);
  const s = ctx.sessions.vps;
  assert.ok(s.execed.some((c) => c.includes('ufw allow 443/udp')));

  await serverAwg.rollback(ctx);
  assert.ok(s.execed.some((c) => c.includes('ufw delete allow 443/udp')));
});

test('server.awg leaves ufw alone when it is inactive', async () => {
  const ctx = ctxWith(BASE);
  await serverAwg.execute(ctx);
  assert.ok(!ctx.sessions.vps.execed.some((c) => c.includes('ufw allow')));
});
