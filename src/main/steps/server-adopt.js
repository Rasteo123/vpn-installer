const { makeStep } = require('./step');
const { parseAwgConf, nextFreePeerIp } = require('../config/awg-conf');

// Adoption: the VPS already runs a stack deployed by this installer (possibly
// for someone else). Instead of reinstalling — which would overwrite awg0.conf
// and cut off existing clients — these steps plug a NEW client into it:
// AWG gets an extra peer, Naive credentials are read back as-is (read-only).

const AWG_CONF = '/etc/amnezia/amneziawg/awg0.conf';
const AWG_BAK = `${AWG_CONF}.adopt.bak`;
const NAIVE_JSON = '/etc/sing-box/naive.json';
const KEY_RE = /^[A-Za-z0-9+/]{42,44}={0,2}$/;

async function detectDeployment(s) {
  return { awg: await s.exists(AWG_CONF), naive: await s.exists(NAIVE_JSON) };
}

// Derive the server public key ON the server: the private key goes straight
// from the config file into `awg pubkey` via a pipe, never into an argv.
const SERVER_PUB = `sh -c '# awg-server-pub
sed -n "s/^PrivateKey *= *//p" ${AWG_CONF} | head -1 | awg pubkey'`;

// Client keypair + PSK for the new peer, kept in shell variables (not visible
// in `ps`), same pattern as the fresh server.awg install.
const ADOPT_KEYGEN = `sh -c '# awg-adopt-keygen
umask 077
cpriv=$(awg genkey); cpub=$(echo "$cpriv" | awg pubkey)
psk=$(awg genpsk)
printf "%s\\n%s\\n%s\\n" "$cpriv" "$cpub" "$psk"'`;

// Push the updated config into the running interface without a restart, so
// existing peers keep their sessions; fall back to a start when it is down.
async function applyAwgConf(s) {
  const active = (await s.exec('systemctl is-active awg-quick@awg0')).stdout.trim();
  if (active === 'active') {
    const r = await s.exec(`bash -c 'awg syncconf awg0 <(awg-quick strip awg0)'`);
    if (r.code !== 0) throw new Error(`server.awg adopt: syncconf failed: ${(r.stderr || '').slice(-300)}`);
  } else {
    await s.exec('systemctl enable awg-quick@awg0 && systemctl restart awg-quick@awg0');
  }
}

const adoptServerAwg = makeStep({
  id: 'server.awg',
  title: 'AmneziaWG (adopt existing server)',
  target: 'vps',

  async preflight(ctx) {
    const s = ctx.sessions.vps;
    if ((await s.exec('command -v awg')).code !== 0) {
      throw new Error('server.awg adopt: server has an AWG config but no awg tools');
    }
    if (!(await s.exists(AWG_CONF))) throw new Error(`server.awg adopt: ${AWG_CONF} not found`);
    parseAwgConf(await s.readFile(AWG_CONF)); // foreign/corrupt config -> clear error before any change
  },

  async execute(ctx) {
    const s = ctx.sessions.vps;
    const log = ctx.log || (() => {});

    const conf = await s.readFile(AWG_CONF);
    const parsed = parseAwgConf(conf);
    const clientAddress = nextFreePeerIp(
      parsed.interface.address,
      parsed.peers.map((p) => p.allowedIps).filter(Boolean)
    );

    log('Existing AmneziaWG found — adding a new client peer...');
    const serverPub = (await s.exec(SERVER_PUB)).stdout.trim();
    if (!KEY_RE.test(serverPub)) throw new Error('server.awg adopt: could not derive the server public key');
    const keys = (await s.exec(ADOPT_KEYGEN)).stdout.trim().split('\n').map((l) => l.trim());
    const [cpriv, cpub, psk] = keys;
    if (keys.length < 3 || !cpriv || !cpub || !psk) {
      throw new Error('server.awg adopt: key generation returned incomplete output');
    }

    log(`Appending peer ${clientAddress}...`);
    await s.exec(`cp -p ${AWG_CONF} ${AWG_BAK}`);
    const peerBlock = `\n[Peer]\n# vpn-installer: adopted client\nPublicKey = ${cpub}\nPresharedKey = ${psk}\nAllowedIPs = ${clientAddress}\n`;
    await s.writeFile(AWG_CONF, conf.replace(/\n*$/, '\n') + peerBlock, { mode: 0o600 });
    await applyAwgConf(s);

    ctx.results.awg = {
      serverPublicKey: serverPub,
      clientPrivateKey: cpriv,
      clientPublicKey: cpub,
      presharedKey: psk,
      obfuscation: parsed.obfuscation,
      listenPort: parsed.interface.listenPort,
      serverAddress: parsed.interface.address,
      clientAddress,
      adopted: true,
    };
    log('Client peer added to the existing AmneziaWG server.');
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    const cpub = ctx.results.awg && ctx.results.awg.clientPublicKey;
    if (!cpub) throw new Error('server.awg adopt: no adopted peer recorded');
    const peers = (await s.exec('awg show awg0 peers')).stdout;
    if (!peers.includes(cpub)) throw new Error('server.awg adopt: new peer not visible on awg0');
  },

  async rollback(ctx) {
    const s = ctx.sessions.vps;
    // Restore exactly the config this run started from; never touch ufw or
    // services beyond re-syncing — the rest belongs to the original install.
    await s.exec(`sh -c 'if [ -f ${AWG_BAK} ]; then cat ${AWG_BAK} > ${AWG_CONF} && rm -f ${AWG_BAK}; fi'`);
    await applyAwgConf(s);
  },
});

const adoptServerNaive = makeStep({
  id: 'server.naive',
  title: 'NaiveProxy (adopt existing server)',
  target: 'vps',

  async preflight(ctx) {
    if (!(await ctx.sessions.vps.exists(NAIVE_JSON))) {
      throw new Error(`server.naive adopt: ${NAIVE_JSON} not found`);
    }
  },

  async execute(ctx) {
    const s = ctx.sessions.vps;
    const log = ctx.log || (() => {});

    let cfg;
    try { cfg = JSON.parse(await s.readFile(NAIVE_JSON)); }
    catch (e) { throw new Error(`server.naive adopt: cannot parse ${NAIVE_JSON}: ${e.message}`); }
    const inbound = (cfg.inbounds || []).find((i) => i && i.type === 'naive');
    const user = inbound && Array.isArray(inbound.users) ? inbound.users[0] : null;
    const domain = inbound && inbound.tls && inbound.tls.server_name;
    if (!inbound || !user || !user.username || !user.password || !domain) {
      throw new Error('server.naive adopt: existing naive config has no usable user/domain');
    }
    if (ctx.inputs.naiveDomain && ctx.inputs.naiveDomain !== domain) {
      log(`Server already runs NaiveProxy for ${domain} — using it (provided domain ignored).`);
    }

    ctx.results.naive = {
      domain,
      username: user.username,
      password: user.password,
      port: inbound.listen_port || 2053,
      adopted: true,
    };
    log('Existing NaiveProxy adopted (credentials reused, server untouched).');
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    // The router will rely on this fallback — only hand over a live one.
    if ((await s.exec('systemctl is-active sing-box-naive')).stdout.trim() !== 'active') {
      throw new Error('server.naive adopt: sing-box-naive is not active on the existing server');
    }
    const port = (ctx.results.naive && ctx.results.naive.port) || 2053;
    const ports = (await s.exec('ss -tulpn')).stdout;
    if (!new RegExp(`:${port}\\b`).test(ports)) {
      throw new Error(`server.naive adopt: nothing listening on ${port}`);
    }
  },
  // no rollback: adoption of naive never changes the server
});

module.exports = { detectDeployment, adoptServerAwg, adoptServerNaive };
