const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerPbr } = require('../../src/main/steps/router-pbr');

const FAST = { pollIntervalMs: 5, pollTimeoutMs: 100 };

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.router = s;
  ctx.timing = FAST;
  return ctx;
}

test('router.pbr builds the RU_DOMAINS policy and registers the loader include', async () => {
  const s = new FakeSSHSession({ 'opkg list-installed': { stdout: 'yes' } });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);

  assert.match(s.written['/tmp/pbr.uci'], /name='RU_DOMAINS_WAN'/);
  assert.match(s.written['/tmp/pbr.uci'], /dest_addr='ru'/);
  assert.strictEqual(ctx.results.pbr.nftset, 'pbr_wan_4_dst_ip_user');
  assert.match(s.written['/etc/awg-bypass/load-ru-cidr.sh'], /pbr_wan_4_dst_ip_user/);
  assert.match(s.written['/tmp/pbr.uci'], /add pbr include/);
  assert.match(s.written['/tmp/pbr.uci'], /path='\/etc\/awg-bypass\/load-ru-cidr\.sh'/);
  assert.match(s.written['/tmp/pbr.uci'], /pbr\.@include\[-1\]\.enabled='1'/);
});

// Re-running the installer must not stack duplicate include sections.
test('router.pbr removes a previously registered include before adding it', async () => {
  const s = new FakeSSHSession({ 'opkg list-installed': { stdout: 'yes' } });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);

  const cleanup = s.execed.find((c) => c.includes('=include$'));
  assert.ok(cleanup, 'expected an idempotent include cleanup command');
  assert.match(cleanup, /load-ru-cidr\.sh/);
});

// The user set has a stable name, so the old grep/head -1 discovery — which
// picked among the config-hashed sets essentially at random — is gone.
test('router.pbr no longer guesses the nftset name', async () => {
  const s = new FakeSSHSession({ 'opkg list-installed': { stdout: 'yes' } });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);

  assert.ok(
    !s.execed.some((c) => c.includes('nft list sets')),
    'nftset discovery must be gone — the user set has a stable name',
  );
});

// The include is what populates the set, so it has to exist on disk before
// the pbr restart that first runs it.
test('router.pbr writes the loader before restarting pbr', async () => {
  const s = new FakeSSHSession({ 'opkg list-installed': { stdout: 'yes' } });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);

  const chmodLoader = s.execed.findIndex((c) => c.includes('chmod +x /etc/awg-bypass/load-ru-cidr.sh'));
  const restart = s.execed.findIndex((c) => c.includes('/etc/init.d/pbr enable'));
  assert.ok(chmodLoader >= 0 && restart >= 0, 'expected both the loader install and the pbr restart');
  assert.ok(chmodLoader < restart, 'loader must be installed before pbr restarts');
});

// The RU_DOMAINS policy resolves via dnsmasq nftset integration, which only
// dnsmasq-full has. On a stock router the bypass would silently do nothing —
// fail before touching anything instead.
test('router.pbr preflight rejects a dnsmasq without nftset support', async () => {
  const basic = makeCtx(new FakeSSHSession({
    'dnsmasq --version': { stdout: 'Dnsmasq version 2.90\nCompile time options: IPv6 no-Lua TFTP ipset no-nftset auth\n' },
  }));
  await assert.rejects(() => routerPbr.preflight(basic), /dnsmasq-full/);

  const missing = makeCtx(new FakeSSHSession());
  await assert.rejects(() => routerPbr.preflight(missing), /dnsmasq-full/);
});

test('router.pbr preflight accepts dnsmasq-full (nftset compiled in)', async () => {
  const full = makeCtx(new FakeSSHSession({
    'dnsmasq --version': { stdout: 'Dnsmasq version 2.90\nCompile time options: IPv6 no-Lua TFTP conntrack ipset nftset auth\n' },
  }));
  await routerPbr.preflight(full); // must not throw
});

test('router.pbr rollback removes the weekly cron entry along with the updater', async () => {
  const s = new FakeSSHSession();
  const ctx = makeCtx(s);
  await routerPbr.rollback(ctx);
  const cron = s.execed.find((c) => c.includes('crontab') && c.includes('update-ru-cidr.sh'));
  assert.ok(cron, 'rollback should rewrite crontab without the updater line');
});

function verifyCtx(overrides) {
  const s = new FakeSSHSession({
    'nft -j list set inet fw4 pbr_wan_4_dst_ip_user': { stdout: '6381\n' },
    'nft list chain inet fw4 pbr_prerouting': { stdout: '1\n' },
    'nft -c -f /var/run/pbr.nft': { stdout: '' },
    ...overrides,
  });
  const ctx = makeCtx(s);
  ctx.results.pbr = { nftset: 'pbr_wan_4_dst_ip_user' };
  return ctx;
}

test('router.pbr verify passes on a healthy ruleset', async () => {
  await routerPbr.verify(verifyCtx({}));
});

test('router.pbr verify fails when the set is underfilled', async () => {
  const ctx = verifyCtx({ 'nft -j list set inet fw4 pbr_wan_4_dst_ip_user': { stdout: '12\n' } });
  await assert.rejects(routerPbr.verify(ctx), /at least 1000/);
});

// The set can be full while PBR installed no rules at all — a corrupt
// /var/run/pbr.nft leaves pbr_prerouting empty and everything falls into the
// tunnel. Counting entries alone would call that healthy.
test('router.pbr verify fails when no rule references the set', async () => {
  const ctx = verifyCtx({ 'nft list chain inet fw4 pbr_prerouting': { stdout: '0\n' } });
  await assert.rejects(routerPbr.verify(ctx), /no rule references/);
});

test('router.pbr verify fails when pbr generated an invalid ruleset file', async () => {
  const ctx = verifyCtx({ 'nft -c -f /var/run/pbr.nft': { stdout: 'syntax error, unexpected -' } });
  await assert.rejects(routerPbr.verify(ctx), /invalid/);
});

test('router.pbr rollback removes the include, both scripts, and reloads pbr', async () => {
  const s = new FakeSSHSession();
  const ctx = makeCtx(s);

  await routerPbr.rollback(ctx);

  const all = s.execed.join('\n');
  assert.match(all, /load-ru-cidr\.sh/);
  assert.match(all, /rm -f \/etc\/awg-bypass\/update-ru-cidr\.sh/);
  assert.match(all, /crontab -/);
  assert.match(all, /\/etc\/init\.d\/pbr reload/);
});
