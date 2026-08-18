const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ASSETS = path.join(__dirname, 'assets', 'olcrtc');
function readAsset(name) {
  return fs.readFileSync(path.join(ASSETS, name), 'utf8');
}

const PRIMARY_HOST = 'conference.ct.placetime.team';
const SECONDARY_HOST = 'meet.mamba.group';

// A room name shared by every install would be a shared fingerprint — the same
// reason the AWG obfuscation parameters are randomized per install.
function generateRoomName() {
  return crypto.randomBytes(24).toString('hex');
}

function profiles({ roomPrimary, roomSecondary }) {
  return `profiles:
  - name: jitsi-primary
    auth:
      provider: jitsi
    room:
      id: "https://${PRIMARY_HOST}/${roomPrimary}"
    net:
      transport: datachannel
  - name: jitsi-secondary
    auth:
      provider: jitsi
    room:
      id: "https://${SECONDARY_HOST}/${roomSecondary}"
    net:
      transport: datachannel
failover:
  retry_delay: 5s
  max_cycles: 0
`;
}

function olcrtcServerYaml({ roomPrimary, roomSecondary }) {
  return `mode: srv
crypto:
  key_file: "/etc/olcrtc/olcrtc.key"
net:
  dns: "1.1.1.1:53"
${profiles({ roomPrimary, roomSecondary })}`;
}

function olcrtcClientYaml({ roomPrimary, roomSecondary, socksPort = 8808 }) {
  return `mode: cnc
crypto:
  key_file: "/etc/olcrtc/olcrtc.key"
net:
  dns: "1.1.1.1:53"
socks:
  host: "127.0.0.1"
  port: ${socksPort}
${profiles({ roomPrimary, roomSecondary })}`;
}

// Marks packets from the olcRTC process into the WAN table, so the WebRTC
// underlay (DNS, HTTPS/WebSocket, ICE, STUN, media) never loops back through
// tun-olcrtc. Matching by uid avoids chasing Jitsi's changing addresses.
function olcrtcUnderlayNft({ uid }) {
  return `add rule inet fw4 pbr_output meta skuid ${uid} goto pbr_mark_0x010000 comment "olcRTC underlay via WAN"\n`;
}

function olcrtcTunJson() { return readAsset('olcrtc-tun.json'); }
function olcrtcServiceUnit() { return readAsset('olcrtc.service'); }
function olcrtcClientInitd() { return readAsset('olcrtc-client.initd'); }
function singBoxOlcrtcInitd() { return readAsset('sing-box-olcrtc.initd'); }

module.exports = {
  generateRoomName,
  olcrtcServerYaml,
  olcrtcClientYaml,
  olcrtcUnderlayNft,
  olcrtcTunJson,
  olcrtcServiceUnit,
  olcrtcClientInitd,
  singBoxOlcrtcInitd,
};
