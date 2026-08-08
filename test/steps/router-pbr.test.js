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

test('router.pbr builds RU_DOMAINS policy and writes updater with discovered nftset', async () => {
  const s = new FakeSSHSession({
    'opkg list-installed': { stdout: 'yes' },
    'nft list sets inet fw4': { stdout: 'pbr_wan_4_dst_ip_cfgABC123\n' },
  });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);

  assert.match(s.written['/tmp/pbr.uci'], /name='RU_DOMAINS_WAN'/);
  assert.match(s.written['/tmp/pbr.uci'], /dest_addr='ru'/);
  assert.strictEqual(ctx.results.pbr.nftset, 'pbr_wan_4_dst_ip_cfgABC123');
  assert.match(s.written['/etc/awg-bypass/update-ru-cidr.sh'], /pbr_wan_4_dst_ip_cfgABC123/);
});

// pbr on a slow router creates its nftset a few seconds after the restart —
// the discovery must retry instead of failing on the first empty answer.
test('router.pbr retries nftset discovery until pbr creates the set', async () => {
  const s = new FakeSSHSession({
    'opkg list-installed': { stdout: 'yes' },
    'nft list sets inet fw4': { stdout: 'pbr_wan_4_dst_ip_cfgABC123\n' },
  });
  s.respondOnce('nft list sets inet fw4', { stdout: '' });
  s.respondOnce('nft list sets inet fw4', { stdout: '' });
  const ctx = makeCtx(s);

  await routerPbr.execute(ctx);
  assert.strictEqual(ctx.results.pbr.nftset, 'pbr_wan_4_dst_ip_cfgABC123');
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
