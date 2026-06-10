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
    username: 'user_b3b9f7aff0d2dfc7',
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

test('nginxServerConf builds an ACME + camouflage site for the domain', () => {
  const out = t.nginxServerConf({ domain: 'ex.mywire.org' });
  assert.match(out, /listen\s+80;/);
  assert.match(out, /location \/\.well-known\/acme-challenge\//);
  assert.match(out, /return 301 https:\/\/\$host\$request_uri;/);
  assert.match(out, /listen\s+443 ssl;/);
  assert.match(out, /server_name ex\.mywire\.org;/);
  assert.match(out, /ssl_certificate \/etc\/letsencrypt\/live\/ex\.mywire\.org\/fullchain\.pem;/);
  assert.match(out, /proxy_pass https:\/\/www\.microsoft\.com;/);
  assert.doesNotMatch(out, /127\.0\.0\.1:1080/);
  assert.doesNotMatch(out, /ssl_preread/);
});
