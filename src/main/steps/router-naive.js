const { makeStep } = require('./step');
const { naiveClientJson, singBoxNaiveInitd } = require('../config/router-templates');

const CONF = '/etc/sing-box/naive-client.json';
const INITD = '/etc/init.d/sing-box-naive';
const MIN_SING_BOX_VERSION = '1.13.12';

function versionAtLeast(actual, minimum) {
  const a = String(actual).split('.').map(Number);
  const b = String(minimum).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

async function singBoxVersion(s) {
  const out = (await s.exec('/usr/bin/sing-box version 2>/dev/null | head -1')).stdout;
  const match = out.match(/sing-box version\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

async function ensureSingBox(s, log) {
  let version = await singBoxVersion(s);
  const tunInstalled = (await s.exec("opkg list-installed 2>/dev/null | grep -q '^kmod-tun ' && echo yes || echo no")).stdout.trim() === 'yes';
  if (versionAtLeast(version || '0.0.0', MIN_SING_BOX_VERSION) && tunInstalled) return;

  log(`Installing sing-box >= ${MIN_SING_BOX_VERSION} and kmod-tun...`);
  await s.exec('opkg update');
  await s.exec('opkg install sing-box kmod-tun');
  version = await singBoxVersion(s);
  if (versionAtLeast(version || '0.0.0', MIN_SING_BOX_VERSION)) return;

  // Some stable OpenWrt feeds lag behind sing-box releases. Fetch the official
  // package matching the router's highest-priority opkg architecture.
  const officialInstall = `set -eu
arch=$(opkg print-architecture | awk '$2 != "all" && $2 != "noarch" { print $2, $3 }' | sort -nk2 | tail -n1 | awk '{ print $1 }')
[ -n "$arch" ]
pkg="/tmp/sing-box_${MIN_SING_BOX_VERSION}_${'$'}{arch}.ipk"
curl -fL --retry 2 -o "$pkg" "https://github.com/SagerNet/sing-box/releases/download/v${MIN_SING_BOX_VERSION}/sing-box_${MIN_SING_BOX_VERSION}_openwrt_${'$'}{arch}.ipk"
opkg install "$pkg"
rm -f "$pkg"`;
  const install = await s.exec(officialInstall);
  version = await singBoxVersion(s);
  if (install.code !== 0 || !versionAtLeast(version || '0.0.0', MIN_SING_BOX_VERSION)) {
    throw new Error(`router.naive: sing-box ${version || 'unknown'} is older than required ${MIN_SING_BOX_VERSION}: ${(install.stderr || '').slice(-200)}`);
  }
}

const SETUP_TUN_NAIVE = [
  'uci -q delete network.tun_naive',
  'uci set network.tun_naive=interface',
  "uci set network.tun_naive.proto='none'",
  "uci set network.tun_naive.device='tun-naive'",
  "uci set network.tun_naive.auto='0'",
].join('; ');

// Idempotently create the naive_fwd firewall zone + lan->naive_fwd forwarding.
const SETUP_NAIVE_FWD = `
if ! uci show firewall | grep -q "name='naive_fwd'"; then
  uci add firewall zone
  uci set firewall.@zone[-1].name='naive_fwd'
  uci set firewall.@zone[-1].input='REJECT'
  uci set firewall.@zone[-1].output='ACCEPT'
  uci set firewall.@zone[-1].forward='REJECT'
  uci set firewall.@zone[-1].masq='1'
  uci set firewall.@zone[-1].mtu_fix='1'
  uci add_list firewall.@zone[-1].network='tun_naive'
fi
if ! uci show firewall | grep -q "dest='naive_fwd'"; then
  uci add firewall forwarding
  uci set firewall.@forwarding[-1].src='lan'
  uci set firewall.@forwarding[-1].dest='naive_fwd'
fi
`;

// Reverse of SETUP_NAIVE_FWD: drop the named zone and its forwarding by name,
// regardless of their anonymous section index.
const TEARDOWN_NAIVE_FWD = `
for f in $(uci show firewall | grep "=forwarding$" | cut -d= -f1); do
  [ "$(uci -q get $f.dest)" = "naive_fwd" ] && uci -q delete $f
done
for z in $(uci show firewall | grep "=zone$" | cut -d= -f1); do
  [ "$(uci -q get $z.name)" = "naive_fwd" ] && uci -q delete $z
done
uci commit firewall
`;

// Configures the NaiveProxy client (sing-box tun) on the router.
const routerNaive = makeStep({
  id: 'router.naive',
  title: 'NaiveProxy client (router)',
  target: 'router',

  async preflight(ctx) {
    if (!ctx.results.naive) throw new Error('router.naive: missing server Naive results (run server.naive first)');
  },

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});
    const n = ctx.results.naive;

    await ensureSingBox(s, log);

    log('Writing naive client config...');
    await s.exec('mkdir -p /etc/sing-box');
    // The client config embeds the proxy password — keep it private.
    await s.writeFile(CONF, naiveClientJson({
      vpsIp: ctx.inputs.vps.host,
      username: n.username,
      password: n.password,
      domain: n.domain,
      naivePort: n.port,
    }), { mode: 0o600 });
    await s.writeFile(INITD, singBoxNaiveInitd());
    await s.exec(`chmod +x ${INITD}`);

    log('Configuring interface + firewall zone...');
    await s.exec(SETUP_TUN_NAIVE);
    await s.exec(SETUP_NAIVE_FWD);
    await s.exec('uci commit network && uci commit firewall');
    await s.exec('/etc/init.d/firewall restart');

    log('Starting service...');
    await s.exec(`${INITD} enable && ${INITD} restart`);
  },

  async verify(ctx) {
    const s = ctx.sessions.router;
    await new Promise((r) => setTimeout(r, 4000));
    if ((await s.exec('pgrep -f naive-client.json')).stdout.trim() === '') {
      throw new Error('router.naive: sing-box (naive) not running');
    }
    if ((await s.exec('ip link show tun-naive')).code !== 0) {
      throw new Error('router.naive: tun-naive interface missing');
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`${INITD} disable 2>/dev/null; ${INITD} stop 2>/dev/null; true`);
    await s.exec('uci -q delete network.tun_naive; uci commit network');
    // Tear down the naive_fwd zone and the lan->naive_fwd forwarding we created.
    await s.exec(TEARDOWN_NAIVE_FWD);
    await s.exec(`rm -f ${CONF} ${INITD}`);
  },
});

module.exports = { routerNaive, versionAtLeast, ensureSingBox };
