const nodeTest = require('node:test');
const assert = require('node:assert');
const { normalize, readReference, referenceExists } = require('./diff-helper');
const test = referenceExists() ? nodeTest : nodeTest.skip;
const r = require('../../src/main/config/router-templates');

test('naiveClientJson reproduces the reference naive-client.json', () => {
  const out = r.naiveClientJson({
    vpsIp: '__VPS_IP__',
    username: 'user_b3b9f7aff0d2dfc7',
    password: '__REDACTED__',
    domain: '__DOMAIN__',
  });
  assert.strictEqual(
    normalize(out),
    normalize(readReference('router/etc/sing-box/naive-client.json')),
  );
});

test('updateRuCidrScript reproduces the reference updater', () => {
  const out = r.updateRuCidrScript({ nftset: 'pbr_wan_4_dst_ip_cfg066ff5' });
  assert.strictEqual(
    normalize(out),
    normalize(readReference('router/etc/awg-bypass/update-ru-cidr.sh')),
  );
});

test('static failover assets match the captured reference', () => {
  assert.strictEqual(normalize(r.vpnFailoverConf()), normalize(readReference('router/etc/vpn-failover.conf')));
  assert.strictEqual(normalize(r.vpnFailoverScript()), normalize(readReference('router/usr/bin/vpn-failover.sh')));
  assert.strictEqual(normalize(r.vpnFailoverInitd()), normalize(readReference('router/etc/init.d/vpn-failover')));
  assert.strictEqual(normalize(r.singBoxNaiveInitd()), normalize(readReference('router/etc/init.d/sing-box-naive')));
});
