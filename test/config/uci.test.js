const test = require('node:test');
const assert = require('node:assert');
const { awgNetworkUci } = require('../../src/main/config/uci');

test('awgNetworkUci sets the awg0 interface, peer, endpoint route and split routes', () => {
  const lines = awgNetworkUci({
    clientPrivateKey: 'CK', clientAddress: '10.66.66.2/32', mtu: 1280,
    obfuscation: {
      jc: 6, jmin: 48, jmax: 96, s1: 64, s2: 132, s3: 196, s4: 88,
      h1: 'a', h2: 'b', h3: 'c', h4: 'd', i1: 'I',
    },
    serverPublicKey: 'SK', presharedKey: 'PSK', vpsIp: '203.0.113.9',
    endpointPort: 443, wanGw: '198.51.100.1',
  });
  const s = lines.join('\n');
  assert.match(s, /set network\.awg0=interface/);
  assert.match(s, /set network\.awg0\.proto='amneziawg'/);
  assert.match(s, /set network\.awg0\.private_key='CK'/);
  assert.match(s, /set network\.awg0\.awg_jc='6'/);
  assert.match(s, /add network amneziawg_awg0/);
  assert.match(s, /\.endpoint_host='203\.0\.113\.9'/);
  assert.match(s, /\.public_key='SK'/);
  assert.match(s, /set network\.@route\[-1\]\.target='203\.0\.113\.9'/);
  assert.match(s, /set network\.@route\[-1\]\.gateway='198\.51\.100\.1'/);
  assert.match(s, /\.target='0\.0\.0\.0'/);
  assert.match(s, /\.target='128\.0\.0\.0'/);
});
