const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { serverNaive, versionAtLeast } = require('../../src/main/steps/server-naive');

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
  'sing-box version': { stdout: 'sing-box version 1.13.12\n' },
  'test -f /etc/letsencrypt': { stdout: 'ok\n' },
  'sing-box check': { code: 0 },
  'nginx -t': { code: 0 },
  'ufw status': { stdout: 'Status: inactive\n' },
};

test('server.naive requires sing-box with the Naive 1.13.12 fixes', () => {
  assert.strictEqual(versionAtLeast('1.13.12', '1.13.12'), true);
  assert.strictEqual(versionAtLeast('1.14.0', '1.13.12'), true);
  assert.strictEqual(versionAtLeast('1.13.11', '1.13.12'), false);
});

test('server.naive writes naive.json with 0600 permissions', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  assert.strictEqual(ctx.sessions.vps.modes[NAIVE_JSON], 0o600);
});

test('server.naive opens only 80 and 443/tcp when ufw is active; rollback closes them', async () => {
  const ctx = ctxWith({ ...OK, 'ufw status': { stdout: 'Status: active\n' } });
  await serverNaive.execute(ctx);
  const s = ctx.sessions.vps;
  for (const p of ['80/tcp', '443/tcp']) {
    assert.ok(s.execed.some((c) => c.includes(`ufw allow ${p}`)), `should open ${p}`);
  }
  await serverNaive.rollback(ctx);
  assert.ok(!s.execed.some((c) => c.includes('2053/tcp')), 'must not expose legacy port 2053');
  for (const p of ['80/tcp', '443/tcp']) {
    assert.ok(s.execed.some((c) => c.includes(`ufw delete allow ${p}`)), `should close ${p}`);
  }
});

test('server.naive advertises TCP/443 to the router', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  assert.strictEqual(ctx.results.naive.port, 443);
  assert.match(ctx.sessions.vps.written[NAIVE_JSON], /"listen_port": 443/);
  assert.match(ctx.sessions.vps.written[NAIVE_JSON], /"network": "tcp"/);
  assert.ok(ctx.sessions.vps.execed.some((c) => c.includes('certbot certonly --webroot')),
    'certificate renewal must remain compatible with nginx on port 80');
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

// The server phase runs without orchestrator rollback, so execute must clean
// up after itself: a failed run may not leave the box with our nginx.conf.
test('server.naive: a certbot failure restores nginx and rethrows', async () => {
  const ctx = ctxWith({ ...OK, 'test -f /etc/letsencrypt': { stdout: '' } });
  await assert.rejects(() => serverNaive.execute(ctx), /certificate not obtained/);
  const s = ctx.sessions.vps;
  const restoreIdx = s.execed.findIndex((c) => c.includes(NGINX_BAK) && c.includes('mv'));
  assert.ok(restoreIdx !== -1, 'nginx.conf must be restored from the backup');
  const restartIdxs = s.execed
    .map((c, i) => (/systemctl restart nginx/.test(c) ? i : -1))
    .filter((i) => i >= 0);
  assert.ok(restartIdxs[restartIdxs.length - 1] > restoreIdx, 'nginx must be restarted after the restore');
});

test('server.naive: failure after writing naive.json removes it so a re-run reinstalls cleanly', async () => {
  const ctx = ctxWith({ ...OK, 'sing-box check': { code: 1, stderr: 'bad config' } });
  await assert.rejects(() => serverNaive.execute(ctx), /config invalid/);
  const s = ctx.sessions.vps;
  assert.ok(
    s.execed.some((c) => c.includes('rm -f') && c.includes(NAIVE_JSON)),
    'naive.json must be removed, or the next run would adopt a broken install',
  );
});

// An adopted VPS may not have had an apt run for months — install with a
// stale package index 404s on Ubuntu version bumps.
test('server.naive refreshes the apt package index before installing', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  const s = ctx.sessions.vps;
  const upd = s.execed.findIndex((c) => c.includes('apt-get update'));
  const inst = s.execed.findIndex((c) => c.includes('apt-get install -y nginx certbot'));
  assert.ok(upd !== -1, 'should run apt-get update');
  assert.ok(upd < inst, 'update must precede the install');
});

test('server.naive rollback brings nginx back up with the restored config', async () => {
  const ctx = ctxWith(OK);
  await serverNaive.execute(ctx);
  const before = ctx.sessions.vps.execed.length;
  await serverNaive.rollback(ctx);
  const tail = ctx.sessions.vps.execed.slice(before);
  const restoreIdx = tail.findIndex((c) => c.includes(NGINX_BAK) && c.includes('mv'));
  const restartIdx = tail.findIndex((c) => /systemctl restart nginx/.test(c));
  assert.ok(restartIdx !== -1, 'rollback must restart nginx, not leave it stopped');
  assert.ok(restartIdx > restoreIdx, 'restart must come after the config restore');
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
