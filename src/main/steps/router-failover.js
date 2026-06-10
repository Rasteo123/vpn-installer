const { makeStep } = require('./step');
const { vpnFailoverConf, vpnFailoverScript, vpnFailoverInitd } = require('../config/router-templates');

const CONF = '/etc/vpn-failover.conf';
const SCRIPT = '/usr/bin/vpn-failover.sh';
const INITD = '/etc/init.d/vpn-failover';

// Installs the awg<->naive failover daemon (procd) that swaps split-default routes.
const routerFailover = makeStep({
  id: 'router.failover',
  title: 'Failover daemon (router)',
  target: 'router',

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});
    log('Writing failover daemon...');
    await s.writeFile(CONF, vpnFailoverConf());
    await s.writeFile(SCRIPT, vpnFailoverScript());
    await s.exec(`chmod +x ${SCRIPT}`);
    await s.writeFile(INITD, vpnFailoverInitd());
    await s.exec(`chmod +x ${INITD}`);
    log('Enabling daemon...');
    await s.exec(`${INITD} enable && ${INITD} restart`);
  },

  async verify(ctx) {
    const s = ctx.sessions.router;
    await new Promise((r) => setTimeout(r, 12000));
    if ((await s.exec('pgrep -f vpn-failover.sh')).stdout.trim() === '') {
      throw new Error('router.failover: daemon not running');
    }
    const state = (await s.exec('cat /var/run/vpn-failover.state 2>/dev/null')).stdout.trim();
    if (!/^(awg|naive)$/.test(state)) {
      throw new Error(`router.failover: no active interface chosen (state='${state}')`);
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`${INITD} disable 2>/dev/null; ${INITD} stop 2>/dev/null; true`);
    await s.exec(`rm -f ${CONF} ${SCRIPT} ${INITD}`);
  },
});

module.exports = { routerFailover };
