const { makeStep } = require('./step');
const { waitFor } = require('./poll');
const { updateRuCidrScript } = require('../config/router-templates');
const { RU_DOMAINS } = require('../config/ru-domains');

const UPDATER = '/etc/awg-bypass/update-ru-cidr.sh';

// Remove any existing RU_DOMAINS_WAN policy (idempotent re-runs).
const DELETE_RU_POLICY =
  'for sct in $(uci show pbr | grep "=policy$" | cut -d= -f1); do ' +
  'if [ "$(uci -q get $sct.name)" = "RU_DOMAINS_WAN" ]; then uci delete $sct; fi; done';

function pbrConfigUci() {
  return [
    'set pbr.config=pbr',
    "set pbr.config.enabled='1'",
    "set pbr.config.strict_enforcement='1'",
    "set pbr.config.resolver_set='dnsmasq.nftset'",
    "set pbr.config.nft_set_flags_interval='1'",
    "set pbr.config.uplink_interface='wan'",
    "set pbr.config.verbosity='2'",
  ];
}

// Policy-based routing: RU domains direct via WAN (dnsmasq.nftset), plus a
// RIPE RU-CIDR auto-updater loading into the same nftset (name discovered live).
const routerPbr = makeStep({
  id: 'router.pbr',
  title: 'PBR + RU bypass (router)',
  target: 'router',

  // The RU_DOMAINS policy resolves through dnsmasq's nftset integration,
  // which only dnsmasq-full compiles in. On stock dnsmasq the domain bypass
  // would silently do nothing, so refuse before anything is changed.
  async preflight(ctx) {
    const s = ctx.sessions.router;
    const out = (await s.exec('dnsmasq --version 2>/dev/null')).stdout;
    if (!out.split(/\s+/).includes('nftset')) {
      throw new Error(
        'router.pbr: dnsmasq on the router lacks nftset support, so the RU domain bypass cannot work. '
        + 'Install dnsmasq-full first (opkg update && opkg remove dnsmasq && opkg install dnsmasq-full) and re-run.'
      );
    }
  },

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});

    if ((await s.exec('opkg list-installed 2>/dev/null | grep -q "^pbr " && echo yes || echo no')).stdout.trim() !== 'yes') {
      log('Installing pbr...');
      await s.exec('opkg update');
      await s.exec('opkg install pbr');
    }

    log('Configuring PBR + RU_DOMAINS policy...');
    await s.exec(DELETE_RU_POLICY);
    const lines = [
      ...pbrConfigUci(),
      'add pbr policy',
      "set pbr.@policy[-1].name='RU_DOMAINS_WAN'",
      "set pbr.@policy[-1].interface='wan'",
    ];
    for (const d of RU_DOMAINS) lines.push(`add_list pbr.@policy[-1].dest_addr='${d}'`);
    await s.writeFile('/tmp/pbr.uci', lines.join('\n') + '\n');
    await s.exec('uci batch < /tmp/pbr.uci');
    await s.exec('uci commit pbr');
    await s.exec('/etc/init.d/pbr enable && /etc/init.d/pbr restart');

    log('Discovering RU nftset...');
    // pbr creates its nftsets some seconds after the restart; poll instead of
    // guessing one fixed delay (slow routers need longer than fast ones).
    const t = ctx.timing || {};
    let nftset = '';
    await waitFor(async () => {
      nftset = (await s.exec("nft list sets inet fw4 2>/dev/null | grep -oE 'pbr_wan_4_dst_ip[A-Za-z0-9_]*' | head -1")).stdout.trim();
      return !!nftset;
    }, { timeoutMs: t.pollTimeoutMs ?? 30000, intervalMs: t.pollIntervalMs ?? 3000 });
    if (!nftset) throw new Error('router.pbr: could not find the pbr wan dst nftset');
    ctx.results.pbr = { nftset };

    log('Installing RU-CIDR updater + weekly cron...');
    await s.exec('mkdir -p /etc/awg-bypass');
    await s.writeFile(UPDATER, updateRuCidrScript({ nftset }));
    await s.exec(`chmod +x ${UPDATER}`);
    await s.exec(`${UPDATER} || true`);
    await s.exec(`( crontab -l 2>/dev/null | grep -v update-ru-cidr.sh; echo '0 4 * * 0 ${UPDATER}' ) | crontab -`);
  },

  async verify(ctx) {
    const s = ctx.sessions.router;
    const set = ctx.results.pbr && ctx.results.pbr.nftset;
    if (!set) throw new Error('router.pbr: nftset not discovered');
    const cnt = (await s.exec(`nft list set inet fw4 ${set} 2>/dev/null | grep -c '/'`)).stdout.trim();
    if (parseInt(cnt, 10) < 10) throw new Error('router.pbr: RU nftset looks empty after update');
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`${DELETE_RU_POLICY}; uci commit pbr`);
    await s.exec(`rm -f ${UPDATER}`);
    // Drop the weekly cron entry too, or cron keeps invoking a removed script.
    await s.exec("( crontab -l 2>/dev/null | grep -v update-ru-cidr.sh ) | crontab -");
  },
});

module.exports = { routerPbr };
