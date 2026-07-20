const nodeTest = require('node:test');
const assert = require('node:assert');
const { normalize, readReference, referenceExists } = require('./diff-helper');
const test = referenceExists() ? nodeTest : nodeTest.skip;
const t = require('../../src/main/config/templates');

// Inputs chosen so the rendered output equals the redacted reference file.
const REF_OBFUSCATION = {
  jc: 6, jmin: 48, jmax: 96, s1: 64, s2: 132, s3: 196, s4: 88,
  h1: '241345077-241346077', h2: '890624709-890625709',
  h3: '1480064884-1480065884', h4: '1935204763-1935205763',
  i1: '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>',
};

test('awgServerConf reproduces the reference awg0.conf', () => {
  const out = t.awgServerConf({
    privateKey: '__REDACTED__',
    obfuscation: REF_OBFUSCATION,
    wanIface: 'eth0',
    peerPublicKey: '__REDACTED__',
    presharedKey: '__REDACTED__',
  });
  assert.strictEqual(
    normalize(out),
    normalize(readReference('vps/etc/amnezia/amneziawg/awg0.conf')),
  );
});

test('awgOverride reproduces the reference override', () => {
  assert.strictEqual(
    normalize(t.awgOverride()),
    normalize(readReference('vps/etc/systemd/awg-override.conf')),
  );
});

test('naiveServerJson reproduces the reference naive.json', () => {
  const out = t.naiveServerJson({
    username: '__NAIVE_USER__',
    password: '__REDACTED__',
    domain: '__DOMAIN__',
  });
  assert.strictEqual(
    normalize(out),
    normalize(readReference('vps/etc/sing-box/naive.json')),
  );
});

test('singBoxNaiveService reproduces the reference unit', () => {
  assert.strictEqual(
    normalize(t.singBoxNaiveService()),
    normalize(readReference('vps/etc/systemd/sing-box-naive.service')),
  );
});

test('nginxServerConf leaves TCP/443 to Naive and serves ACME on port 80', () => {
  const out = t.nginxServerConf({ domain: 'ex.mywire.org' });
  assert.match(out, /listen\s+80;/);
  assert.match(out, /location \/\.well-known\/acme-challenge\//);
  assert.match(out, /return 302 https:\/\/www\.microsoft\.com\$request_uri;/);
  assert.doesNotMatch(out, /listen\s+443/);
  assert.match(out, /server_name ex\.mywire\.org;/);
  assert.doesNotMatch(out, /ssl_certificate/);
  assert.doesNotMatch(out, /proxy_pass/);
  assert.doesNotMatch(out, /127\.0\.0\.1:1080/);
  assert.doesNotMatch(out, /ssl_preread/);
});

nodeTest('Naive and AWG can share port 443 because Naive is pinned to TCP', () => {
  const out = t.naiveServerJson({ username: 'u', password: 'p', domain: 'ex.org' });
  assert.match(out, /"listen_port": 443/);
  assert.match(out, /"network": "tcp"/);
  assert.doesNotMatch(out, /2053/);
});
