const test = require('node:test');
const assert = require('node:assert');
const t = require('../../src/main/config/olcrtc-templates');

test('generateRoomName returns 32 hex chars and differs between calls', () => {
  const a = t.generateRoomName();
  const b = t.generateRoomName();
  assert.match(a, /^[0-9a-f]{48}$/, 'must match the entropy of the qualified deployment');
  assert.notStrictEqual(a, b);
});

test('olcrtcServerYaml renders both rooms in server mode', () => {
  const out = t.olcrtcServerYaml({ roomPrimary: 'aaa', roomSecondary: 'bbb' });
  assert.match(out, /^mode: srv$/m);
  assert.match(out, /conference\.ct\.placetime\.team\/aaa/);
  assert.match(out, /meet\.mamba\.group\/bbb/);
  assert.doesNotMatch(out, /__ROOM_/);
});

test('olcrtcClientYaml renders client mode with the local SOCKS listener', () => {
  const out = t.olcrtcClientYaml({ roomPrimary: 'aaa', roomSecondary: 'bbb' });
  assert.match(out, /^mode: cnc$/m);
  assert.match(out, /host: "127\.0\.0\.1"/);
  assert.match(out, /port: 8808/);
  assert.doesNotMatch(out, /__ROOM_/);
});

// The WebRTC connection is the underlay and must never re-enter tun-olcrtc.
// The uid is whatever the router actually allocated, not a constant: a fixed
// uid makes the install fail outright when that id is already taken.
test('olcrtcUnderlayNft renders the allocated uid', () => {
  const out = t.olcrtcUnderlayNft({ uid: 60123 });
  assert.match(out, /meta skuid 60123 goto pbr_mark_0x010000/);
  assert.doesNotMatch(out, /45321/);
});

// olcRTC is TCP-only; letting QUIC try UDP just makes clients wait for a
// timeout before falling back.
test('olcrtcTunJson blocks UDP and routes everything else to the SOCKS outbound', () => {
  const cfg = JSON.parse(t.olcrtcTunJson());
  assert.strictEqual(cfg.inbounds[0].interface_name, 'tun-olcrtc');
  assert.strictEqual(cfg.route.final, 'olcrtc-socks');
  assert.ok(cfg.route.rules.some((r) => r.network === 'udp' && r.outbound === 'block-out'));
});

test('the shipped init scripts and unit match what the steps expect', () => {
  assert.match(t.olcrtcClientInitd(), /procd_set_param user olcrtc/);
  assert.match(t.singBoxOlcrtcInitd(), /olcrtc-tun\.json/);
  assert.match(t.olcrtcServiceUnit(), /ExecStart=\/usr\/local\/bin\/olcrtc/);
  assert.match(t.olcrtcServiceUnit(), /^User=olcrtc$/m);
});

// Measured on the router: a firewall reload does not attach the zone, only
// bringing the uci interface up does — and the device only exists while the
// tier runs, so the trigger has to be the device appearing.
test('the hotplug asset brings the uci interface up when the tun appears', () => {
  const h = t.olcrtcHotplug();
  assert.match(h, /\$DEVICE" = "tun-olcrtc"/);
  assert.match(h, /add\)\s*ifup tun_olcrtc/);
  assert.match(h, /remove\)\s*ifdown tun_olcrtc/);
});

// Packaging contract: the .gz binaries are excluded from the asar and shipped
// as extraResources, which took the whole olcrtc asset directory with them.
// The text assets must therefore be read through the same resolver, not from
// __dirname — otherwise every template throws ENOENT in a packaged build.
test('templates read assets through the shared resolver, not a hardcoded path', () => {
  const src = require('fs').readFileSync(require.resolve('../../src/main/config/olcrtc-templates'), 'utf8');
  assert.match(src, /resolveOlcrtcAssets/);
  assert.doesNotMatch(src, /__dirname, 'assets', 'olcrtc'/);
});

test('every asset the templates need is present where extraResources copies from', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'src', 'main', 'config', 'assets', 'olcrtc');
  for (const f of ['olcrtc-tun.json', 'olcrtc.service', 'olcrtc-client.initd', 'sing-box-olcrtc.initd', 'olcrtc-hotplug', 'SHA256SUMS']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} must ship with the app`);
  }
});
