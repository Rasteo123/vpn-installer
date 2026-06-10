const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { routerPbr } = require('../../src/main/steps/router-pbr');

test('router.pbr builds RU_DOMAINS policy and writes updater with discovered nftset', async () => {
  const s = new FakeSSHSession({
    'opkg list-installed': { stdout: 'yes' },
    'nft list sets inet fw4': { stdout: 'pbr_wan_4_dst_ip_cfgABC123\n' },
  });
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.router = s;

  await routerPbr.execute(ctx);

  assert.match(s.written['/tmp/pbr.uci'], /name='RU_DOMAINS_WAN'/);
  assert.match(s.written['/tmp/pbr.uci'], /dest_addr='ru'/);
  assert.strictEqual(ctx.results.pbr.nftset, 'pbr_wan_4_dst_ip_cfgABC123');
  assert.match(s.written['/etc/awg-bypass/update-ru-cidr.sh'], /pbr_wan_4_dst_ip_cfgABC123/);
});
