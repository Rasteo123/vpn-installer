const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { SkippableError } = require('../../src/main/steps/skippable');
const { routerOlcrtc } = require('../../src/main/steps/router-olcrtc');

const FAST = { pollIntervalMs: 5, pollTimeoutMs: 100, olcrtcReadyMs: 200 };

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.router = s;
  ctx.timing = FAST;
  ctx.results.olcrtc = { roomPrimary: 'a'.repeat(48), roomSecondary: 'b'.repeat(48), key: 'c'.repeat(64) };
  return ctx;
}

// Fixture strings copied from the live router, not invented.
function okSession(overrides = {}) {
  return new FakeSSHSession({
    'uname -m': { stdout: 'aarch64\n' },
    'sing-box version': { stdout: 'sing-box version 1.13.12\n' },
    'awk -F: ': { stdout: '' },
    'nft -a list chain inet fw4 pbr_output': {
      stdout: 'table inet fw4 {\n\tchain pbr_output { # handle 110\n\t\tmeta skuid 45321 goto pbr_mark_0x010000 comment "olcrtc-probe" # handle 3306\n\t}\n}\n',
    },
    'netstat -tln': { stdout: '1\n' },
    'ip link show tun-olcrtc': { stdout: '42: tun-olcrtc: <POINTOPOINT,UP>\n' },
    ...overrides,
  });
}

test('router.olcrtc preflight declines an unsupported architecture, skippably', async () => {
  const ctx = makeCtx(okSession({ 'uname -m': { stdout: 'mips\n' } }));
  await assert.rejects(routerOlcrtc.preflight(ctx), (e) => e instanceof SkippableError && /mips/.test(e.message));
});

test('router.olcrtc preflight declines an old sing-box, skippably', async () => {
  const ctx = makeCtx(okSession({ 'sing-box version': { stdout: 'sing-box version 1.9.0\n' } }));
  await assert.rejects(routerOlcrtc.preflight(ctx), (e) => e instanceof SkippableError && /1\.13\.12/.test(e.message));
});

test('router.olcrtc preflight accepts a newer sing-box', async () => {
  const ctx = makeCtx(okSession({ 'sing-box version': { stdout: 'sing-box version 1.14.0\n' } }));
  await routerOlcrtc.preflight(ctx);
  assert.strictEqual(ctx.results.olcrtcRouter.uid, 45321);
});

// If the firmware cannot mark packets by uid, the WebRTC underlay would loop
// back through its own tunnel. Decline rather than install a guaranteed loop.
test('router.olcrtc preflight declines when the uid mark probe does not stick', async () => {
  const ctx = makeCtx(okSession({ 'nft -a list chain inet fw4 pbr_output': { stdout: 'chain pbr_output {\n}\n' } }));
  await assert.rejects(routerOlcrtc.preflight(ctx), (e) => e instanceof SkippableError && /uid/i.test(e.message));
});

test('router.olcrtc preflight cleans up its probe rule', async () => {
  const s = okSession();
  await routerOlcrtc.preflight(makeCtx(s));
  assert.ok(s.execed.some((c) => /nft delete rule inet fw4 pbr_output handle 3306/.test(c)));
});

// The preferred uid is already taken by something else: take the next free one
// instead of refusing to install.
test('router.olcrtc preflight allocates a different uid when 45321 is taken', async () => {
  const s = okSession({ 'awk -F: ': { stdout: 'someoneelse\n' } });
  s.respondOnce('for u in $(seq', { stdout: '45322\n' });
  const ctx = makeCtx(s);
  await routerOlcrtc.preflight(ctx);
  assert.strictEqual(ctx.results.olcrtcRouter.uid, 45322);
});

test('router.olcrtc installs the client, tun config and underlay rule', async () => {
  const s = okSession();
  const ctx = makeCtx(s);
  await routerOlcrtc.preflight(ctx);
  await routerOlcrtc.execute(ctx);

  assert.ok(Buffer.isBuffer(s.written['/usr/bin/olcrtc']));
  assert.match(s.written['/etc/olcrtc/client.yaml'], /^mode: cnc$/m);
  assert.strictEqual(s.written['/etc/olcrtc/olcrtc.key'], 'c'.repeat(64));
  assert.strictEqual(s.modes['/etc/olcrtc/olcrtc.key'], 0o600);
  assert.match(s.written['/etc/sing-box/olcrtc-tun.json'], /tun-olcrtc/);
  assert.match(
    s.written['/usr/share/nftables.d/ruleset-post/31-olcrtc-underlay.nft'],
    /meta skuid 45321 goto pbr_mark_0x010000/,
  );
});

// Lazy activation is the whole design: the services exist but must not come up
// on their own, or the third tier would run all the time.
test('router.olcrtc never enables the services at boot', async () => {
  const s = okSession();
  const ctx = makeCtx(s);
  await routerOlcrtc.preflight(ctx);
  await routerOlcrtc.execute(ctx);
  assert.ok(!s.execed.some((c) => /\/etc\/init\.d\/olcrtc-client enable/.test(c)));
  assert.ok(!s.execed.some((c) => /\/etc\/init\.d\/sing-box-olcrtc enable/.test(c)));
});

// A one-shot check was tried on a live run and failed: the measured pair needs
// about 3s for SOCKS and 4s for the tun.
test('router.olcrtc verify waits for readiness, then stops the services again', async () => {
  const s = okSession();
  s.respondOnce('netstat -tln', { stdout: '0\n' });
  s.respondOnce('ip link show tun-olcrtc', { stdout: '' });
  const ctx = makeCtx(s);

  await routerOlcrtc.verify(ctx);

  const all = s.execed.join('\n');
  assert.match(all, /\/etc\/init\.d\/olcrtc-client start/);
  assert.match(all, /\/etc\/init\.d\/olcrtc-client stop/);
  assert.match(all, /\/etc\/init\.d\/sing-box-olcrtc stop/);
});

// Even when readiness never arrives, the services must not be left running.
test('router.olcrtc verify stops the services even when readiness times out', async () => {
  const s = okSession({ 'netstat -tln': { stdout: '0\n' } });
  const ctx = makeCtx(s);

  await assert.rejects(routerOlcrtc.verify(ctx));
  assert.ok(s.execed.some((c) => /\/etc\/init\.d\/olcrtc-client stop/.test(c)));
});

test('router.olcrtc rollback removes everything it installed', async () => {
  const s = okSession();
  await routerOlcrtc.rollback(makeCtx(s));
  const all = s.execed.join('\n');
  assert.match(all, /rm -f \/usr\/bin\/olcrtc/);
  assert.match(all, /rm -rf \/etc\/olcrtc/);
  assert.match(all, /31-olcrtc-underlay\.nft/);
});
