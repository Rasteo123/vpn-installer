// Parses an existing server awg0.conf so a new install run can ADOPT the
// deployment (add another peer) instead of recreating it. The client must use
// the SAME obfuscation parameters as the server, so they are read back here.
// The PrivateKey value is deliberately never extracted — only its presence.

const NUM_OBF = { Jc: 'jc', Jmin: 'jmin', Jmax: 'jmax', S1: 's1', S2: 's2', S3: 's3', S4: 's4' };
const STR_OBF = { H1: 'h1', H2: 'h2', H3: 'h3', H4: 'h4', I1: 'i1' };

function parseAwgConf(content) {
  const iface = { hasPrivateKey: false };
  const obfuscation = {};
  const peers = [];
  let section = null;
  let sawInterface = false;

  for (const raw of String(content).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[Interface]') { section = 'interface'; sawInterface = true; continue; }
    if (line === '[Peer]') { section = 'peer'; peers.push({}); continue; }
    const eq = line.indexOf('=');
    if (eq < 0 || !section) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (section === 'interface') {
      if (key === 'PrivateKey') iface.hasPrivateKey = true;
      else if (key === 'Address') iface.address = value;
      else if (key === 'ListenPort') iface.listenPort = Number(value);
      else if (key === 'MTU') iface.mtu = Number(value);
      else if (key in NUM_OBF) obfuscation[NUM_OBF[key]] = Number(value);
      else if (key in STR_OBF) obfuscation[STR_OBF[key]] = value;
    } else {
      const peer = peers[peers.length - 1];
      if (key === 'PublicKey') peer.publicKey = value;
      else if (key === 'PresharedKey') peer.presharedKey = value;
      else if (key === 'AllowedIPs') peer.allowedIps = value;
    }
  }

  if (!sawInterface) throw new Error('parseAwgConf: not an AmneziaWG interface config');
  if (!iface.listenPort || !iface.address) {
    throw new Error('parseAwgConf: ListenPort/Address missing — not a config this installer can adopt');
  }
  return { interface: iface, obfuscation, peers };
}

// First free host in the interface's /24, never the server's own address.
// The base is derived from the Address line — no hardcoded subnets.
function nextFreePeerIp(serverAddress, usedIps) {
  const m = String(serverAddress).match(/^(\d+\.\d+\.\d+)\.(\d+)\/(\d+)$/);
  if (!m || m[3] !== '24') {
    throw new Error(`nextFreePeerIp: expected a /24 interface address, got '${serverAddress}'`);
  }
  const prefix = m[1];
  const used = new Set(usedIps.map((ip) => String(ip).split('/')[0]));
  used.add(`${prefix}.${m[2]}`);
  for (let host = 2; host <= 254; host++) {
    const candidate = `${prefix}.${host}`;
    if (!used.has(candidate)) return `${candidate}/32`;
  }
  throw new Error(`nextFreePeerIp: no free peer addresses left in ${prefix}.0/24`);
}

module.exports = { parseAwgConf, nextFreePeerIp };
