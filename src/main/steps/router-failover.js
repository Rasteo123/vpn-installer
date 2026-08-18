const { makeStep } = require('./step');
const { waitFor } = require('./poll');
const { vpnFailoverConf, vpnFailoverScript, vpnFailoverCore, vpnFailoverInitd } = require('../config/router-templates');

const CONF = '/etc/vpn-failover.conf';
const SCRIPT = '/usr/bin/vpn-failover.sh';
const INITD = '/etc/init.d/vpn-failover';

// Installs the four-tier failover daemon (procd) that swaps split-default
// routes: awg -> naive -> olcrtc -> direct WAN.
const routerFailover = makeStep({
  id: 'router.failover',
  title: 'Failover daemon (router)',
  target: 'router',

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});
    log('Writing failover daemon...');
    await s.writeFile(CONF, vpnFailoverConf());
    // The daemon sources this; it must exist before the daemon starts.
    await s.exec('mkdir -p /usr/lib/vpn-failover');
    await s.writeFile('/usr/lib/vpn-failover/core.sh', vpnFailoverCore());
    await s.writeFile(SCRIPT, vpnFailoverScript());
    await s.exec(`chmod +x ${SCRIPT}`);
    await s.writeFile(INITD, vpnFailoverInitd());
    await s.exec(`chmod +x ${INITD}`);
    log('Enabling daemon...');
    await s.exec(`${INITD} enable && ${INITD} restart`);
  },

  async verify(ctx) {
    const s = ctx.sessions.router;
    if ((await s.exec('pgrep -f vpn-failover.sh')).stdout.trim() === '') {
      throw new Error('router.failover: daemon not running');
    }
    // The daemon probes both tunnels (up to ~10s) before its first state
    // write; poll for the state file instead of one fixed-delay sample.
    const t = ctx.timing || {};
    let state = '';
    await waitFor(async () => {
      state = (await s.exec('cat /var/run/vpn-failover.state 2>/dev/null')).stdout.trim();
      return /^(awg|naive|olcrtc|wan)$/.test(state);
    }, { timeoutMs: t.pollTimeoutMs ?? 30000, intervalMs: t.pollIntervalMs ?? 3000 });
    if (!/^(awg|naive|olcrtc|wan)$/.test(state)) {
      throw new Error(`router.failover: no valid route state chosen (state='${state}')`);
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`${INITD} disable 2>/dev/null; ${INITD} stop 2>/dev/null; true`);
    await s.exec(`rm -f ${CONF} ${SCRIPT} ${INITD}`);
  },
});

module.exports = { routerFailover };
