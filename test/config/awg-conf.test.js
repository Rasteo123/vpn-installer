const test = require('node:test');
const assert = require('node:assert');
const { awgServerConf } = require('../../src/main/config/templates');
const { generateObfuscation } = require('../../src/main/config/generate');
const { parseAwgConf, nextFreePeerIp } = require('../../src/main/config/awg-conf');

function renderedConf(obfuscation) {
  return awgServerConf({
    privateKey: 'SERVERPRIV',
    obfuscation,
    wanIface: 'eth0',
    peerPublicKey: 'PEER1PUB',
    presharedKey: 'PEER1PSK',
  });
}

test('parseAwgConf round-trips what awgServerConf renders', () => {
  const obfuscation = generateObfuscation();
  const parsed = parseAwgConf(renderedConf(obfuscation));

  assert.strictEqual(parsed.interface.listenPort, 443);
  assert.strictEqual(parsed.interface.address, '10.66.66.1/24');
  assert.strictEqual(parsed.interface.mtu, 1280);
  // the PrivateKey value must NOT be extracted, only its presence noted
  assert.strictEqual(parsed.interface.hasPrivateKey, true);
  assert.ok(!JSON.stringify(parsed).includes('SERVERPRIV'));
  assert.deepStrictEqual(parsed.obfuscation, obfuscation);
  assert.deepStrictEqual(parsed.peers, [
    { publicKey: 'PEER1PUB', presharedKey: 'PEER1PSK', allowedIps: '10.66.66.2/32' },
  ]);
});

test('parseAwgConf handles a conf with extra appended peers', () => {
  const conf = renderedConf(generateObfuscation()) +
    '\n[Peer]\n# vpn-installer client\nPublicKey = PEER2PUB\nPresharedKey = PEER2PSK\nAllowedIPs = 10.66.66.3/32\n';
  const parsed = parseAwgConf(conf);
  assert.strictEqual(parsed.peers.length, 2);
  assert.deepStrictEqual(parsed.peers[1], {
    publicKey: 'PEER2PUB', presharedKey: 'PEER2PSK', allowedIps: '10.66.66.3/32',
  });
});

test('parseAwgConf rejects content that is not an AWG interface config', () => {
  assert.throws(() => parseAwgConf('server {\n listen 80;\n}\n'), /not .*AmneziaWG/i);
  assert.throws(() => parseAwgConf(''), /not .*AmneziaWG/i);
  // [Interface] present but no usable fields
  assert.throws(() => parseAwgConf('[Interface]\n'), /ListenPort|Address/);
});

test('nextFreePeerIp picks the first free host in the interface subnet', () => {
  assert.strictEqual(nextFreePeerIp('10.66.66.1/24', ['10.66.66.2/32']), '10.66.66.3/32');
  // fills gaps left by removed peers
  assert.strictEqual(nextFreePeerIp('10.66.66.1/24', ['10.66.66.2/32', '10.66.66.4/32']), '10.66.66.3/32');
  // base comes from the Address line, not hardcoded
  assert.strictEqual(nextFreePeerIp('192.168.77.1/24', []), '192.168.77.2/32');
  // the server's own host is never handed out
  assert.strictEqual(nextFreePeerIp('10.9.9.5/24', []), '10.9.9.2/32');
  assert.strictEqual(nextFreePeerIp('10.9.9.1/24', ['10.9.9.2/32']).includes('10.9.9.1'), false);
});

test('nextFreePeerIp throws when the subnet is exhausted or not /24', () => {
  const all = [];
  for (let i = 2; i <= 254; i++) all.push(`10.66.66.${i}/32`);
  assert.throws(() => nextFreePeerIp('10.66.66.1/24', all), /free|свободн/i);
  assert.throws(() => nextFreePeerIp('10.66.66.1/16', []), /\/24/);
});
