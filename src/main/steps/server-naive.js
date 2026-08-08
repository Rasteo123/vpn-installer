const { makeStep } = require('./step');
const { naiveServerJson, singBoxNaiveService, nginxServerConf } = require('../config/templates');
const { generateNaiveCreds } = require('../config/generate');
const { openUfwPorts, closeUfwPorts } = require('./ufw');

const NAIVE_JSON = '/etc/sing-box/naive.json';
const NAIVE_UNIT = '/etc/systemd/system/sing-box-naive.service';
const NGINX_CONF = '/etc/nginx/nginx.conf';
const NGINX_BAK = '/etc/nginx/nginx.conf.vpn-installer.bak';
const APT_TIMEOUT = { timeoutMs: 900000 };
const MIN_SING_BOX_VERSION = '1.13.12';
const NAIVE_PORT = 443;
const UFW_PORTS = ['80/tcp', '443/tcp'];

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
  const out = (await s.exec('sing-box version 2>/dev/null | head -1')).stdout;
  const match = out.match(/sing-box version\s+(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

// Best-effort return to the pre-install state: our naive unit gone, the saved
// nginx.conf back and nginx running again. Shared by the in-run failure path
// (the server phase runs WITHOUT orchestrator rollback, so execute must clean
// up after itself) and by rollback(). Never throws — when called from the
// failure path the original error must stay visible.
async function restoreServerState(s, ufwPortsToClose) {
  try {
    await s.exec('systemctl stop sing-box-naive 2>/dev/null; systemctl disable sing-box-naive 2>/dev/null; true');
    // Remove the half-written naive config too, or the next run would try to
    // adopt a broken install instead of reinstalling cleanly.
    await s.exec(`rm -f ${NAIVE_JSON} ${NAIVE_UNIT}`);
    await s.exec(`if [ -f ${NGINX_BAK} ]; then mv ${NGINX_BAK} ${NGINX_CONF}; fi`);
    await s.exec('systemctl daemon-reload');
    await s.exec('systemctl restart nginx 2>/dev/null; true');
    await closeUfwPorts(s, ufwPortsToClose);
  } catch { /* best effort */ }
}

// The actual install sequence, separated so execute() can wrap it in its
// cleanup-on-failure handler. Reports the ufw ports it opened via onUfwPorts
// as soon as they are known, so the handler closes exactly those.
async function installNaive(ctx, onUfwPorts) {
  const s = ctx.sessions.vps;
  const log = ctx.log || (() => {});
  const domain = ctx.inputs.naiveDomain;

  log('Installing nginx, certbot, sing-box...');
  await s.exec('dpkg --configure -a 2>/dev/null || true');
  // An adopted VPS may not have run apt for months — installing against a
  // stale package index 404s on Ubuntu version bumps.
  await s.exec('DEBIAN_FRONTEND=noninteractive apt-get update -y', APT_TIMEOUT);
  await s.exec('DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot', APT_TIMEOUT);
  const sb = await s.exec('bash -c "$(curl -fsSL https://sing-box.app/deb-install.sh)"', APT_TIMEOUT);
  if ((await s.exec('command -v sing-box')).code !== 0) {
    throw new Error(`server.naive: sing-box install failed: ${sb.stderr.slice(-300)}`);
  }
  const installedVersion = await singBoxVersion(s);
  if (!installedVersion || !versionAtLeast(installedVersion, MIN_SING_BOX_VERSION)) {
    throw new Error(`server.naive: sing-box ${installedVersion || 'unknown'} is older than required ${MIN_SING_BOX_VERSION}`);
  }

  log('Preparing the ACME web root...');
  await s.exec('mkdir -p /etc/sing-box /var/www/html');
  await s.exec('rm -f /etc/nginx/sites-enabled/default');
  // Preserve the distro's nginx.conf so a failed run can restore it instead
  // of leaving the box with our config (or none). -n: don't clobber a prior backup.
  await s.exec(`[ -f ${NGINX_CONF} ] && cp -n ${NGINX_CONF} ${NGINX_BAK} || true`);
  await s.writeFile(NGINX_CONF, nginxServerConf({ domain }));
  const ngt = await s.exec('nginx -t 2>&1');
  if (ngt.code !== 0) throw new Error(`server.naive: nginx config invalid: ${ngt.stdout.slice(-300)}`);
  onUfwPorts(await openUfwPorts(s, UFW_PORTS));
  await s.exec('systemctl enable nginx && systemctl restart nginx');

  // Webroot mode keeps renewal compatible with nginx remaining on TCP/80.
  log('Obtaining Let\'s Encrypt certificate...');
  const staging = ctx.inputs.certStaging ? ' --test-cert' : '';
  const cert = await s.exec(`certbot certonly --webroot -w /var/www/html -d ${domain} --non-interactive --agree-tos -m admin@${domain} --no-eff-email${staging}`);
  if ((await s.exec(`test -f /etc/letsencrypt/live/${domain}/fullchain.pem && echo ok`)).stdout.trim() !== 'ok') {
    throw new Error(`server.naive: certificate not obtained:\n${cert.stdout.slice(-400)}\n${cert.stderr.slice(-400)}`);
  }

  log('Writing NaiveProxy config...');
  const creds = generateNaiveCreds();
  // naive.json holds the proxy password — keep it private.
  await s.writeFile(NAIVE_JSON, naiveServerJson({
    username: creds.username,
    password: creds.password,
    domain,
    listenPort: NAIVE_PORT,
  }), { mode: 0o600 });
  await s.writeFile(NAIVE_UNIT, singBoxNaiveService());
  const chk = await s.exec(`sing-box check -c ${NAIVE_JSON}`);
  if (chk.code !== 0) throw new Error(`server.naive: sing-box config invalid: ${chk.stderr.slice(-300)}`);

  log('Starting services...');
  await s.exec('systemctl daemon-reload');
  await s.exec('systemctl enable sing-box-naive && systemctl restart sing-box-naive');

  ctx.results.naive = { domain, username: creds.username, password: creds.password, port: NAIVE_PORT };
  log('NaiveProxy + nginx installed.');
}

// Installs NaiveProxy (sing-box) on TCP/443 with a Let's Encrypt cert. nginx
// remains on TCP/80 for ACME renewal; AWG can independently use UDP/443.
const serverNaive = makeStep({
  id: 'server.naive',
  title: 'NaiveProxy + nginx (server)',
  target: 'vps',

  async preflight(ctx) {
    const s = ctx.sessions.vps;
    const domain = ctx.inputs.naiveDomain;
    if (!domain) throw new Error('server.naive: naiveDomain is required');
    const myIp = (await s.exec('curl -s -4 --max-time 8 ifconfig.me')).stdout.trim();
    const resolved = (await s.exec(`getent hosts ${domain} | awk '{print $1}' | head -1`)).stdout.trim();
    if (!resolved) throw new Error(`server.naive: ${domain} does not resolve`);
    if (myIp && resolved !== myIp) {
      throw new Error(`server.naive: ${domain} -> ${resolved}, not this VPS (${myIp}); point the DNS A record first`);
    }
  },

  async execute(ctx) {
    const s = ctx.sessions.vps;
    let addedPorts = [];
    try {
      await installNaive(ctx, (p) => { addedPorts = p; });
    } catch (err) {
      await restoreServerState(s, addedPorts);
      throw err;
    }
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    for (const svc of ['sing-box-naive', 'nginx']) {
      if ((await s.exec(`systemctl is-active ${svc}`)).stdout.trim() !== 'active') {
        const st = (await s.exec(`systemctl status ${svc} --no-pager -l | tail -20`)).stdout;
        throw new Error(`server.naive: ${svc} not active:\n${st}`);
      }
    }
    const ports = (await s.exec('ss -tlpn')).stdout;
    if (!new RegExp(`:${NAIVE_PORT}\\b.*sing-box`).test(ports)) {
      throw new Error(`server.naive: sing-box is not listening on TCP/${NAIVE_PORT}`);
    }
    if (!/:80\b.*nginx/.test(ports)) throw new Error('server.naive: nginx not listening on TCP/80');
  },

  // Restores the saved nginx.conf and brings nginx back up — a box that had a
  // working nginx before us must not be left with it stopped.
  async rollback(ctx) {
    await restoreServerState(ctx.sessions.vps, UFW_PORTS);
  },
});

module.exports = { serverNaive, versionAtLeast };
