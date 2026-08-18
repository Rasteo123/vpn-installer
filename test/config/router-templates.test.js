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

// This script is no longer a reproduction of the captured router state: the
// captured version loads the RU list into a PBR-managed policy set via
// `nft -f`, which PBR wipes on every reload. Applying now belongs to the
// include (loadRuCidrScript), so the updater is asserted on behaviour rather
// than pinned to a snapshot that records the old, transient arrangement.
nodeTest('updateRuCidrScript downloads the RIPE list and validates its size', () => {
  const out = r.updateRuCidrScript();
  assert.match(out, /stat\.ripe\.net/);
  assert.match(out, /ru_cidr\.raw/);
  assert.match(out, /-lt 1000/);
});

nodeTest('updateRuCidrScript reloads pbr and never touches nft itself', () => {
  const out = r.updateRuCidrScript();
  assert.match(out, /\/etc\/init\.d\/pbr reload/);
  assert.doesNotMatch(out, /nft -f/);
  assert.doesNotMatch(out, /add element/);
});

// vpn-failover.sh and .conf are no longer compared to the captured reference:
// that snapshot predates the olcRTC tier, while the four-level version shipped
// here is the one running on the live router. The behavioural assertions below
// cover them instead.
test('static failover assets match the captured reference', () => {
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
  assert.match(script, /elif \[ "\$cur_dev" != "\$desired_dev" \]/);
  // Re-asserting the tier already in force must not wait out the holddown.
  assert.match(script, /elif \[ "\$cur_dev" != "\$desired_dev" \]; then\s+#[\s\S]*?apply_route "\$wanted"/);
});

nodeTest('failover removes VPN routes and falls open to WAN when every tunnel fails', () => {
  const script = r.vpnFailoverScript();
  assert.match(script, /wan\)\s+[\s\S]*ip route del "\$SPLIT_ROUTE_A"[\s\S]*ip route del "\$SPLIT_ROUTE_B"/);
  assert.match(script, /write_state "\$route_target"/);
  // wan is the last resort in the shared selection table, not a special case
  // spelled out in the daemon.
  assert.match(r.vpnFailoverCore(), /printf '%s\\n' wan/);
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

nodeTest('vpnFailoverCore exposes the four-level selection as pure functions', () => {
  const core = r.vpnFailoverCore();
  assert.match(core, /desired_target\(\)/);
  assert.match(core, /needs_olcrtc\(\)/);
  for (const tier of ['awg', 'naive', 'olcrtc', 'wan']) {
    assert.match(core, new RegExp(`printf '%s\\\\n' ${tier}`), `tier ${tier} must be selectable`);
  }
});

nodeTest('the failover daemon drives the olcrtc tier and its start timeout', () => {
  assert.match(r.vpnFailoverScript(), /olcrtc/);
  assert.match(r.vpnFailoverScript(), /core\.sh/);
  assert.match(r.vpnFailoverConf(), /OLCRTC_START_TIMEOUT=\d+/);
  assert.match(r.vpnFailoverConf(), /OLCRTC_SOCKS_PORT=8808/);
});
