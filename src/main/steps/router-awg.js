const { makeStep } = require('./step');
const { uciBatch, awgNetworkUci } = require('../config/uci');

const AWG_PKGS = 'amneziawg-tools kmod-amneziawg luci-app-amneziawg';

// Idempotently add awg0 to the firewall 'wan' zone (works for named or
// anonymous zone sections). JS plain string — shell vars must stay literal.
const ADD_AWG0_TO_WAN =
  'for z in $(uci show firewall | grep -E "\\.name=.wan.$" | cut -d. -f1-2); do ' +
  'uci -q get "$z.network" | grep -qw awg0 || uci add_list "$z.network=awg0"; done';

// Configures the AmneziaWG client on the router using the server's keys.
const routerAwg = makeStep({
  id: 'router.awg',
  title: 'AmneziaWG (router)',
  target: 'router',

  async preflight(ctx) {
    const s = ctx.sessions.router;
    if (!ctx.results.awg) throw new Error('router.awg: missing server AWG results (run server.awg first)');
    if ((await s.exec('command -v uci')).code !== 0) throw new Error('router.awg: not an OpenWrt/uci router');
    const route = await s.exec('ip route show default');
    const m = route.stdout.match(/default\s+via\s+(\S+)/);
    if (!m) throw new Error('router.awg: could not detect WAN gateway');
    ctx.results.detected = { ...(ctx.results.detected || {}), routerWanGw: m[1] };
  },

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});
    const awg = ctx.results.awg;

    if ((await s.exec('command -v awg')).code !== 0) {
      log('Installing AmneziaWG packages...');
      await s.exec('opkg update');
      const r = await s.exec(`opkg install ${AWG_PKGS}`);
      if ((await s.exec('command -v awg')).code !== 0) {
        throw new Error(`router.awg: package install failed: ${(r.stderr || '').slice(-200)}`);
      }
    }

    log('Configuring awg0...');
    const lines = awgNetworkUci({
      clientPrivateKey: awg.clientPrivateKey,
      clientAddress: awg.clientAddress,
      obfuscation: awg.obfuscation,
      serverPublicKey: awg.serverPublicKey,
      presharedKey: awg.presharedKey,
      vpsIp: ctx.inputs.vps.host,
      endpointPort: awg.listenPort,
      wanGw: ctx.results.detected.routerWanGw,
    });
    await s.writeFile('/tmp/awg.uci', uciBatch(lines));
    await s.exec('uci batch < /tmp/awg.uci');
    await s.exec(ADD_AWG0_TO_WAN);
    await s.exec('uci commit network && uci commit firewall');

    log('Restarting network...');
    await s.exec('/etc/init.d/network restart');
  },

  async verify(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`ping -c1 -W3 ${ctx.inputs.vps.host} >/dev/null 2>&1 || true`);
    await new Promise((r) => setTimeout(r, 8000));
    const show = await s.exec('awg show awg0');
    if (!/peer:/.test(show.stdout)) throw new Error('router.awg: no peer configured on awg0');
    if (!/latest handshake/.test(show.stdout)) throw new Error('router.awg: no handshake with the server');
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec('uci -q delete network.awg0; uci -q delete network.@amneziawg_awg0[0]; uci commit network');
  },
});

module.exports = { routerAwg };
