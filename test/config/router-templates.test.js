const nodeTest = require('node:test');
const assert = require('node:assert');
const { normalize, readReference, referenceExists } = require('./diff-helper');
const test = referenceExists() ? nodeTest : nodeTest.skip;
const r = require('../../src/main/config/router-templates');

test('naiveClientJson reproduces the reference naive-client.json', () => {
  const out = r.naiveClientJson({
    vpsIp: '__VPS_IP__',
    username: '__NAIVE_USER__',
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

// netifd re-installs the uci split routes via awg0 on any network reload; the
// daemon must compare the actual route device with the desired one each cycle,
// not only its own remembered state — or a reload while awg is dead black-holes
// all traffic until awg recovers.
nodeTest('failover re-applies routes when netifd re-installs them behind its back', () => {
  const script = r.vpnFailoverScript();
  assert.match(script, /cur_dev=\$\(ip route show "\$SPLIT_ROUTE_A"/);
  assert.match(script, /\[ "\$want" != "\$active" \] \|\| \[ "\$cur_dev" != "\$desired_dev" \]/);
});

nodeTest('failover removes VPN routes and records WAN when both tunnels fail', () => {
  const script = r.vpnFailoverScript();
  assert.match(script, /wan\)\s+[\s\S]*ip route del "\$SPLIT_ROUTE_A"[\s\S]*ip route del "\$SPLIT_ROUTE_B"/);
  assert.match(script, /echo "wan" > "\$STATE_FILE"/);
  assert.match(script, /else\s+apply_route wan\s+fi/);
  assert.match(script, /else\s+want=wan\s+fi/);
  assert.doesNotMatch(script, /holding state/);
});

// The template tests below assert on rendered strings only, so they must run
// even without a captured reference snapshot — hence nodeTest, not the
// snapshot-gated `test` alias above.

nodeTest('loadRuCidrScript loads the cached list into the given nftset', () => {
  const out = r.loadRuCidrScript({ nftset: 'pbr_wan_4_dst_ip_user' });
  assert.match(out, /pbr_wan_4_dst_ip_user/);
  assert.match(out, /ru_cidr\.raw/);
  assert.match(out, /TARGET_TABLE='inet fw4'/);
  assert.match(out, /add element \$TARGET_TABLE \$NFTSET/);
});

// PBR intercepts `nft` inside include scripts and splices the arguments into
// /var/run/pbr.nft. `nft -f <file>` therefore corrupts that file and PBR
// installs NO rules at all, silently. Only the single-string form is safe.
nodeTest('loadRuCidrScript never uses nft -f', () => {
  const out = r.loadRuCidrScript({ nftset: 'pbr_wan_4_dst_ip_user' });
  const calls = out.split('\n').filter((l) => /^\s*nft\s/.test(l));
  assert.ok(calls.length > 0, 'expected at least one nft invocation');
  for (const call of calls) {
    assert.doesNotMatch(call, /nft\s+-f/, `forbidden "nft -f" form: ${call}`);
    assert.match(call, /nft\s+"add element/, `unexpected nft form: ${call}`);
  }
});

nodeTest('loadRuCidrScript sends the list in chunks rather than one huge command', () => {
  const out = r.loadRuCidrScript({ nftset: 'pbr_wan_4_dst_ip_user' });
  assert.match(out, /CHUNK=\d+/);
});

nodeTest('loadRuCidrScript refuses to load a suspiciously small list', () => {
  const out = r.loadRuCidrScript({ nftset: 'pbr_wan_4_dst_ip_user' });
  assert.match(out, /-ge 1000/);
});
