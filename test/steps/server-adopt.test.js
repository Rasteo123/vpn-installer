const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { awgServerConf, naiveServerJson } = require('../../src/main/config/templates');
const { generateObfuscation } = require('../../src/main/config/generate');
const { detectDeployment, adoptServerAwg, adoptServerNaive } = require('../../src/main/steps/server-adopt');

const AWG_CONF = '/etc/amnezia/amneziawg/awg0.conf';
const NAIVE_JSON = '/etc/sing-box/naive.json';

// Realistic-looking 44-char base64 keys (wg key validation is length-based).
const SRVPUB = 'S'.repeat(43) + '=';
const CPRIV = 'c'.repeat(43) + '=';
const CPUB = 'C'.repeat(43) + '=';
const PSK = 'P'.repeat(43) + '=';

function seededAwgConf(obfuscation) {
  return awgServerConf({
    privateKey: 'X'.repeat(43) + '=',
    obfuscation,
    wanIface: 'eth0',
    peerPublicKey: 'F'.repeat(43) + '=',
    presharedKey: 'G'.repeat(43) + '=',
  });
}

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.vps = s;
  return ctx;
}

test('detectDeployment reports which components exist on the VPS', async () => {
  const s = new FakeSSHSession();
  assert.deepStrictEqual(await detectDeployment(s), { awg: false, naive: false });
  s.written[AWG_CONF] = 'x';
  assert.deepStrictEqual(await detectDeployment(s), { awg: true, naive: false });
  s.written[NAIVE_JSON] = 'x';
  assert.deepStrictEqual(await detectDeployment(s), { awg: true, naive: true });
});

test('adopt awg: appends a new peer and applies it without touching existing ones', async () => {
  const obf = generateObfuscation();
  const s = new FakeSSHSession({
    '# awg-server-pub': { stdout: SRVPUB + '\n' },
    '# awg-adopt-keygen': { stdout: `${CPRIV}\n${CPUB}\n${PSK}\n` },
    'systemctl is-active awg-quick@awg0': { stdout: 'active\n' },
  });
  s.written[AWG_CONF] = seededAwgConf(obf);
  const ctx = makeCtx(s);

  await adoptServerAwg.preflight(ctx);
  await adoptServerAwg.execute(ctx);

  const conf = s.written[AWG_CONF];
  // the original peer is preserved, the new one appended
  assert.ok(conf.includes('F'.repeat(43) + '='), 'original peer kept');
  assert.ok(conf.includes(`PublicKey = ${CPUB}`), 'new peer public key');
  assert.ok(conf.includes(`PresharedKey = ${PSK}`), 'new peer psk');
  assert.ok(conf.includes('AllowedIPs = 10.66.66.3/32'), 'next free address');
  assert.strictEqual(s.modes[AWG_CONF], 0o600);

  // backup before rewrite, then live sync (no service restart = no disruption)
  assert.ok(s.execed.some((c) => c.startsWith('cp') && c.includes('.adopt.bak')), 'backup taken');
  assert.ok(s.execed.some((c) => c.includes('awg syncconf awg0')), 'syncconf applied');
  assert.ok(!s.execed.some((c) => c.includes('systemctl restart awg-quick@awg0')), 'no restart');

  // the private key must never appear in a command line (visible via ps)
  assert.ok(!s.execed.some((c) => c.includes(CPRIV)), 'private key not in argv');

  assert.deepStrictEqual(ctx.results.awg, {
    serverPublicKey: SRVPUB,
    clientPrivateKey: CPRIV,
    clientPublicKey: CPUB,
    presharedKey: PSK,
    obfuscation: obf,
    listenPort: 443,
    serverAddress: '10.66.66.1/24',
    clientAddress: '10.66.66.3/32',
    adopted: true,
  });
});

test('adopt awg: restarts the service instead of syncconf when it is not running', async () => {
  const s = new FakeSSHSession({
    '# awg-server-pub': { stdout: SRVPUB + '\n' },
    '# awg-adopt-keygen': { stdout: `${CPRIV}\n${CPUB}\n${PSK}\n` },
    'systemctl is-active awg-quick@awg0': { stdout: 'inactive\n', code: 3 },
  });
  s.written[AWG_CONF] = seededAwgConf(generateObfuscation());
  const ctx = makeCtx(s);

  await adoptServerAwg.execute(ctx);

  assert.ok(s.execed.some((c) => c.includes('systemctl enable awg-quick@awg0') && c.includes('restart awg-quick@awg0')));
  assert.ok(!s.execed.some((c) => c.includes('awg syncconf')));
});

test('adopt awg: verify checks the new peer is visible on awg0', async () => {
  const ok = new FakeSSHSession({ 'awg show awg0 peers': { stdout: `${'Z'.repeat(43)}=\n${CPUB}\n` } });
  const ctxOk = makeCtx(ok);
  ctxOk.results.awg = { clientPublicKey: CPUB };
  await adoptServerAwg.verify(ctxOk);

  const bad = new FakeSSHSession({ 'awg show awg0 peers': { stdout: `${'Z'.repeat(43)}=\n` } });
  const ctxBad = makeCtx(bad);
  ctxBad.results.awg = { clientPublicKey: CPUB };
  await assert.rejects(() => adoptServerAwg.verify(ctxBad), /peer/i);
});

test('adopt awg: rollback restores the pre-adopt config from the backup', async () => {
  const s = new FakeSSHSession({ 'systemctl is-active awg-quick@awg0': { stdout: 'active\n' } });
  const ctx = makeCtx(s);
  await adoptServerAwg.rollback(ctx);
  assert.ok(s.execed.some((c) => c.includes('.adopt.bak') && c.includes(AWG_CONF)));
  assert.ok(s.execed.some((c) => c.includes('awg syncconf awg0')), 're-synced after restore');
});

test('adopt awg: preflight rejects a server without awg tools or with a foreign config', async () => {
  const noAwg = new FakeSSHSession({ 'command -v awg': { code: 1 } });
  noAwg.written[AWG_CONF] = seededAwgConf(generateObfuscation());
  await assert.rejects(() => adoptServerAwg.preflight(makeCtx(noAwg)), /awg/);

  const foreign = new FakeSSHSession();
  foreign.written[AWG_CONF] = 'this is not an ini file';
  await assert.rejects(() => adoptServerAwg.preflight(makeCtx(foreign)), /AmneziaWG|adopt/i);
});

test('adopt awg: fails cleanly when the peer subnet is exhausted', async () => {
  let conf = seededAwgConf(generateObfuscation());
  for (let i = 3; i <= 254; i++) {
    conf += `\n[Peer]\nPublicKey = Q${i}\nPresharedKey = W${i}\nAllowedIPs = 10.66.66.${i}/32\n`;
  }
  const s = new FakeSSHSession({
    '# awg-server-pub': { stdout: SRVPUB + '\n' },
    '# awg-adopt-keygen': { stdout: `${CPRIV}\n${CPUB}\n${PSK}\n` },
  });
  s.written[AWG_CONF] = conf;
  await assert.rejects(() => adoptServerAwg.execute(makeCtx(s)), /free/);
});

test('adopt naive: reads creds/domain/port from the existing server config, read-only', async () => {
  const s = new FakeSSHSession();
  s.written[NAIVE_JSON] = naiveServerJson({ username: 'u1', password: 'p1', domain: 'ex.org' });
  const ctx = makeCtx(s);

  await adoptServerNaive.preflight(ctx);
  await adoptServerNaive.execute(ctx);

  assert.deepStrictEqual(ctx.results.naive, {
    domain: 'ex.org', username: 'u1', password: 'p1', port: 2053, adopted: true,
  });
  // read-only: nothing written, nothing restarted
  assert.strictEqual(s.written[NAIVE_JSON].includes('"u1"'), true);
  assert.ok(!s.execed.some((c) => c.includes('systemctl restart')));
});

test('adopt naive: verify demands a live service on the advertised port', async () => {
  const ok = new FakeSSHSession({
    'systemctl is-active sing-box-naive': { stdout: 'active\n' },
    'ss -tulpn': { stdout: 'tcp LISTEN 0.0.0.0:2053\n' },
  });
  const ctxOk = makeCtx(ok);
  ctxOk.results.naive = { port: 2053 };
  await adoptServerNaive.verify(ctxOk);

  const dead = new FakeSSHSession({ 'systemctl is-active sing-box-naive': { stdout: 'inactive\n', code: 3 } });
  const ctxDead = makeCtx(dead);
  ctxDead.results.naive = { port: 2053 };
  await assert.rejects(() => adoptServerNaive.verify(ctxDead), /sing-box-naive/);
});

test('adopt naive: preflight/execute reject a missing or unreadable config', async () => {
  await assert.rejects(() => adoptServerNaive.preflight(makeCtx(new FakeSSHSession())), /naive/i);

  const broken = new FakeSSHSession();
  broken.written[NAIVE_JSON] = '{ not json';
  await assert.rejects(() => adoptServerNaive.execute(makeCtx(broken)), /naive/i);
});
