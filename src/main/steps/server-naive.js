const { makeStep } = require('./step');
const { naiveServerJson, singBoxNaiveService, nginxServerConf } = require('../config/templates');
const { generateNaiveCreds } = require('../config/generate');

const NAIVE_JSON = '/etc/sing-box/naive.json';
const NAIVE_UNIT = '/etc/systemd/system/sing-box-naive.service';
const NGINX_CONF = '/etc/nginx/nginx.conf';

// Installs NaiveProxy (sing-box) on :2053 with a Let's Encrypt cert, plus an
// nginx ACME(:80) + camouflage(:443) site for the domain.
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
    const log = ctx.log || (() => {});
    const domain = ctx.inputs.naiveDomain;

    log('Installing nginx, certbot, sing-box...');
    await s.exec('DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot');
    const sb = await s.exec('bash -c "$(curl -fsSL https://sing-box.app/deb-install.sh)"');
    if ((await s.exec('command -v sing-box')).code !== 0) {
      throw new Error(`server.naive: sing-box install failed: ${sb.stderr.slice(-300)}`);
    }

    log('Obtaining Let\'s Encrypt certificate...');
    await s.exec('systemctl stop nginx 2>/dev/null; true');
    const staging = ctx.inputs.certStaging ? ' --test-cert' : '';
    const cert = await s.exec(`certbot certonly --standalone -d ${domain} --non-interactive --agree-tos -m admin@${domain} --no-eff-email${staging}`);
    if ((await s.exec(`test -f /etc/letsencrypt/live/${domain}/fullchain.pem && echo ok`)).stdout.trim() !== 'ok') {
      throw new Error(`server.naive: certificate not obtained:\n${cert.stdout.slice(-400)}\n${cert.stderr.slice(-400)}`);
    }

    log('Writing configs...');
    const creds = generateNaiveCreds();
    await s.exec('mkdir -p /etc/sing-box /var/www/html');
    await s.writeFile(NAIVE_JSON, naiveServerJson({ username: creds.username, password: creds.password, domain }));
    await s.writeFile(NAIVE_UNIT, singBoxNaiveService());
    await s.exec('rm -f /etc/nginx/sites-enabled/default');
    await s.writeFile(NGINX_CONF, nginxServerConf({ domain }));

    const chk = await s.exec(`sing-box check -c ${NAIVE_JSON}`);
    if (chk.code !== 0) throw new Error(`server.naive: sing-box config invalid: ${chk.stderr.slice(-300)}`);
    const ngt = await s.exec('nginx -t 2>&1');
    if (ngt.code !== 0) throw new Error(`server.naive: nginx config invalid: ${ngt.stdout.slice(-300)}`);

    log('Starting services...');
    await s.exec('systemctl daemon-reload');
    await s.exec('systemctl enable sing-box-naive && systemctl restart sing-box-naive');
    await s.exec('systemctl enable nginx && systemctl restart nginx');

    ctx.results.naive = { domain, username: creds.username, password: creds.password, port: 2053 };
    log('NaiveProxy + nginx installed.');
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    for (const svc of ['sing-box-naive', 'nginx']) {
      if ((await s.exec(`systemctl is-active ${svc}`)).stdout.trim() !== 'active') {
        const st = (await s.exec(`systemctl status ${svc} --no-pager -l | tail -20`)).stdout;
        throw new Error(`server.naive: ${svc} not active:\n${st}`);
      }
    }
    const ports = (await s.exec('ss -tulpn')).stdout;
    if (!/:2053\b/.test(ports)) throw new Error('server.naive: nothing listening on 2053');
    if (!/:443\b/.test(ports)) throw new Error('server.naive: nginx not listening on 443');
  },

  async rollback(ctx) {
    const s = ctx.sessions.vps;
    await s.exec('systemctl stop sing-box-naive nginx 2>/dev/null; systemctl disable sing-box-naive 2>/dev/null; true');
    await s.exec(`rm -f ${NAIVE_JSON} ${NAIVE_UNIT} ${NGINX_CONF}; systemctl daemon-reload`);
  },
});

module.exports = { serverNaive };
