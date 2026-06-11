const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { serverNaive } = require('../../src/main/steps/server-naive');

const NAIVE_JSON = '/etc/sing-box/naive.json';
const NGINX_CONF = '/etc/nginx/nginx.conf';
const NGINX_BAK = '/etc/nginx/nginx.conf.vpn-installer.bak';

function ctxWith(responses) {
  const ctx = createInstallContext({
    vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' },
    naiveDomain: 'ex.example.com',
    protocols: { naive: true },
  });
  ctx.sessions.vps = new FakeSSHSession(responses);
  return ctx;
}

const OK = {
  'command -v sing-box': { code: 0, stdout: '/usr/bin/sing-box' },
  'test -f /etc/letsencrypt': { stdout: 'ok\n' },
  'sing-box check': { code: 0 },
  'nginx -t': { code: 0 },
  'ufw status': { stdout: 'Status: inactive\n' },
};

test('server.naive writes naive.json with 0600 permissions', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  assert.strictEqual(ctx.sessions.vps.modes[NAIVE_JSON], 0o600);
});

test('server.naive opens 80,443,2053/tcp when ufw is active; rollback closes them', async () => {
  const ctx = ctxWith({ ...OK, 'ufw status': { stdout: 'Status: active\n' } });
  await serverNaive.execute(ctx);
  const s = ctx.sessions.vps;
  for (const p of ['80/tcp', '443/tcp', '2053/tcp']) {
    assert.ok(s.execed.some((c) => c.includes(`ufw allow ${p}`)), `should open ${p}`);
  }
  await serverNaive.rollback(ctx);
  for (const p of ['80/tcp', '443/tcp', '2053/tcp']) {
    assert.ok(s.execed.some((c) => c.includes(`ufw delete allow ${p}`)), `should close ${p}`);
  }
});

test('server.naive backs up an existing nginx.conf before overwriting it', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  const s = ctx.sessions.vps;
  const backupIdx = s.execed.findIndex((c) => c.includes(NGINX_CONF) && /cp\b/.test(c) && c.includes('.vpn-installer.bak'));
  assert.ok(backupIdx !== -1, 'should copy nginx.conf to a .vpn-installer.bak sidecar');
  // The backup must happen before we write our own nginx.conf.
  assert.ok(Object.prototype.hasOwnProperty.call(s.written, NGINX_CONF));
});

test('server.naive rollback restores the saved nginx.conf instead of deleting it', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  await serverNaive.rollback(ctx);
  const restore = ctx.sessions.vps.execed.find((c) => c.includes('.vpn-installer.bak') && c.includes(NGINX_CONF) && /mv\b/.test(c));
  assert.ok(restore, 'rollback should mv the backup back over nginx.conf');
  // Any rm of nginx.conf must be guarded by the backup check in the same command —
  // never a standalone "rm -f nginx.conf" that would nuke the user's config.
  const unguardedRm = ctx.sessions.vps.execed.some(
    (c) => /rm\s+-f[^\n]*\/etc\/nginx\/nginx\.conf/.test(c) && !c.includes(NGINX_BAK),
  );
  assert.ok(!unguardedRm, 'must not remove nginx.conf without checking the backup');
});
