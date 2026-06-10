const { makeStep } = require('./step');
const { awgServerConf, awgOverride } = require('../config/templates');
const { generateObfuscation } = require('../config/generate');

const CONF = '/etc/amnezia/amneziawg/awg0.conf';
const OVERRIDE_DIR = '/etc/systemd/system/awg-quick@awg0.service.d';

// Installs AmneziaWG on the Ubuntu VPS, generates keys, writes the config
// (with iptables NAT in PostUp), and starts the service.
const serverAwg = makeStep({
  id: 'server.awg',
  title: 'AmneziaWG (server)',
  target: 'vps',

  async preflight(ctx) {
    const s = ctx.sessions.vps;
    const os = await s.exec('. /etc/os-release 2>/dev/null && echo "$ID"');
    if (!/ubuntu/i.test(os.stdout)) throw new Error('server.awg: only Ubuntu is supported');
    const route = await s.exec('ip route show default');
    const m = route.stdout.match(/dev\s+(\S+)/);
    if (!m) throw new Error('server.awg: could not detect WAN interface');
    ctx.results.detected = { ...(ctx.results.detected || {}), wanIface: m[1] };
  },

  async execute(ctx) {
    const s = ctx.sessions.vps;
    const log = ctx.log || (() => {});

    log('Installing AmneziaWG (apt + PPA)...');
    await s.exec('DEBIAN_FRONTEND=noninteractive apt-get update -y');
    await s.exec('DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common');
    await s.exec('add-apt-repository -y ppa:amnezia/ppa');
    await s.exec('DEBIAN_FRONTEND=noninteractive apt-get update -y');
    const inst = await s.exec('DEBIAN_FRONTEND=noninteractive apt-get install -y amneziawg amneziawg-tools linux-headers-$(uname -r)');
    if (inst.code !== 0) throw new Error(`server.awg: package install failed: ${inst.stderr.slice(-300)}`);

    log('Generating keys...');
    const serverPriv = (await s.exec('awg genkey')).stdout.trim();
    const serverPub = (await s.exec(`echo '${serverPriv}' | awg pubkey`)).stdout.trim();
    const clientPriv = (await s.exec('awg genkey')).stdout.trim();
    const clientPub = (await s.exec(`echo '${clientPriv}' | awg pubkey`)).stdout.trim();
    const psk = (await s.exec('awg genpsk')).stdout.trim();
    if (!serverPub || !clientPub || !psk) throw new Error('server.awg: key generation returned empty output');

    const obfuscation = generateObfuscation();
    const wanIface = ctx.results.detected.wanIface;

    log('Writing config...');
    await s.exec(`mkdir -p /etc/amnezia/amneziawg ${OVERRIDE_DIR}`);
    await s.writeFile(CONF, awgServerConf({
      privateKey: serverPriv,
      obfuscation,
      wanIface,
      peerPublicKey: clientPub,
      presharedKey: psk,
    }));
    await s.writeFile(`${OVERRIDE_DIR}/override.conf`, awgOverride());
    await s.exec('echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-awg.conf && sysctl --system >/dev/null');

    log('Starting service...');
    await s.exec('systemctl daemon-reload');
    await s.exec('systemctl enable awg-quick@awg0 && systemctl restart awg-quick@awg0');

    ctx.results.awg = {
      serverPublicKey: serverPub,
      clientPrivateKey: clientPriv,
      presharedKey: psk,
      obfuscation,
      listenPort: 443,
      serverAddress: '10.66.66.1/24',
      clientAddress: '10.66.66.2/32',
      wanIface,
    };
    log('AmneziaWG installed.');
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    const active = (await s.exec('systemctl is-active awg-quick@awg0')).stdout.trim();
    if (active !== 'active') {
      const status = (await s.exec('systemctl status awg-quick@awg0 --no-pager -l | tail -20')).stdout;
      throw new Error(`server.awg: service not active:\n${status}`);
    }
    const show = await s.exec('awg show awg0');
    if (!/listening port:\s*443/.test(show.stdout)) {
      throw new Error('server.awg: awg0 not listening on 443');
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.vps;
    await s.exec('systemctl stop awg-quick@awg0 2>/dev/null; systemctl disable awg-quick@awg0 2>/dev/null; true');
    await s.exec(`rm -rf /etc/amnezia/amneziawg ${OVERRIDE_DIR} /etc/sysctl.d/99-awg.conf`);
  },
});

module.exports = { serverAwg };
