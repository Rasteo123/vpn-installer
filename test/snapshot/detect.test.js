const test = require('node:test');
const assert = require('node:assert');
const { buildValueMap } = require('../../src/main/snapshot/detect');

test('maps VPS, router WAN/LAN IPs to stable tokens', () => {
  const map = buildValueMap({ vpsIp: '203.0.113.9', wanIp: '198.51.100.7', lanIp: '192.168.1.1' });
  assert.strictEqual(map['203.0.113.9'], '__VPS_IP__');
  assert.strictEqual(map['198.51.100.7'], '__ROUTER_WAN_IP__');
  assert.strictEqual(map['192.168.1.1'], '__ROUTER_LAN_IP__');
});

test('extracts the naive domain AND username from the client config', () => {
  const naiveJson = '{ "server_name": "vpn.example.com", "username": "user_0123456789abcdef" }';
  const map = buildValueMap({ naiveJson });
  assert.strictEqual(map['vpn.example.com'], '__DOMAIN__');
  assert.strictEqual(map['user_0123456789abcdef'], '__NAIVE_USER__');
});

test('extracts the WAN gateway and ISP DNS servers (these identify the line)', () => {
  const map = buildValueMap({
    defaultRoute: 'default via 130.255.42.129 dev eth1 proto static',
    wanDns: '80.78.115.1 89.107.115.1',
  });
  assert.strictEqual(map['130.255.42.129'], '__ROUTER_WAN_GW__');
  assert.strictEqual(map['80.78.115.1'], '__ROUTER_DNS__');
  assert.strictEqual(map['89.107.115.1'], '__ROUTER_DNS__');
});

test('omits anything not detected (no empty keys)', () => {
  const map = buildValueMap({ vpsIp: '', naiveJson: '{}', wanDns: '' });
  assert.ok(!('' in map));
  assert.deepStrictEqual(map, {});
});
