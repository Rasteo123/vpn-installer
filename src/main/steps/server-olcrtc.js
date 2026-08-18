const { makeStep } = require('./step');
const { loadBinary } = require('../config/olcrtc-assets');
const {
  generateRoomName,
  olcrtcServerYaml,
  olcrtcServiceUnit,
} = require('../config/olcrtc-templates');

const BIN = '/usr/local/bin/olcrtc';
const CONF_DIR = '/etc/olcrtc';
const KEY_FILE = `${CONF_DIR}/olcrtc.key`;
const UNIT = '/etc/systemd/system/olcrtc.service';

// Third fallback, below AmneziaWG and NaiveProxy: a tunnel over a public Jitsi
// DataChannel. It opens no public port — the router-side client meets this
// process in a private room.
const serverOlcrtc = makeStep({
  id: 'server.olcrtc',
  title: 'olcRTC fallback server (VPS)',
  target: 'vps',

  async preflight(ctx) {
    const s = ctx.sessions.vps;
    const arch = (await s.exec('uname -m')).stdout.trim();
    if (arch !== 'x86_64') {
      throw new Error(`server.olcrtc: only x86_64 is shipped, this VPS reports ${arch}`);
    }
    if (!(await s.exec('command -v systemctl')).stdout.trim()) {
      throw new Error('server.olcrtc: systemd is required to run the olcRTC service');
    }
  },

  // Adopt an existing deployment instead of reinstalling over it: a restart
  // would drop the tunnel of anyone already using this server. The rooms and
  // key are recovered here because router.olcrtc still needs them.
  async isApplied(ctx) {
    const s = ctx.sessions.vps;
    if ((await s.exec('systemctl is-active olcrtc')).stdout.trim() !== 'active') return false;

    const yaml = (await s.exec(`cat ${CONF_DIR}/server.yaml 2>/dev/null`)).stdout;
    // Length is not pinned: the qualified deployment uses 48 hex chars, this
    // installer writes 48 too, and assuming one exact size would silently fail
    // to adopt anything else.
    const rooms = [...yaml.matchAll(/id:\s*"https:\/\/[^/"]+\/([0-9a-f]{32,64})"/g)].map((m) => m[1]);
    const key = (await s.exec(`cat ${KEY_FILE} 2>/dev/null`)).stdout.trim();
    if (rooms.length < 2 || !/^[0-9a-f]{64}$/.test(key)) return false;

    ctx.results.olcrtc = { roomPrimary: rooms[0], roomSecondary: rooms[1], key };
    return true;
  },

  async execute(ctx) {
    const s = ctx.sessions.vps;
    const log = ctx.log || (() => {});

    log('Installing olcRTC server...');
    await s.exec('id -u olcrtc >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin olcrtc');
    await s.exec(`mkdir -p ${CONF_DIR} && chmod 750 ${CONF_DIR}`);

    await s.writeFile(BIN, await loadBinary('amd64'), { mode: 0o755 });

    // Generated on the server so the key never lands in a command line, the
    // same rule the AWG keys follow.
    await s.exec(`[ -s ${KEY_FILE} ] || openssl rand -hex 32 > ${KEY_FILE}`);
    await s.exec(`chmod 600 ${KEY_FILE} && chown olcrtc:olcrtc ${KEY_FILE}`);
    const key = (await s.exec(`cat ${KEY_FILE}`)).stdout.trim();

    const roomPrimary = generateRoomName();
    const roomSecondary = generateRoomName();
    await s.writeFile(`${CONF_DIR}/server.yaml`, olcrtcServerYaml({ roomPrimary, roomSecondary }), { mode: 0o600 });
    await s.exec(`chown -R olcrtc:olcrtc ${CONF_DIR}`);

    await s.writeFile(UNIT, olcrtcServiceUnit());
    await s.exec('systemctl daemon-reload');
    await s.exec('systemctl enable olcrtc');
    await s.exec('systemctl restart olcrtc');

    ctx.results.olcrtc = { roomPrimary, roomSecondary, key };
  },

  async verify(ctx) {
    const s = ctx.sessions.vps;
    const state = (await s.exec('systemctl is-active olcrtc')).stdout.trim();
    if (state !== 'active') {
      throw new Error(`server.olcrtc: unit is not active (${state || 'unknown'})`);
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.vps;
    await s.exec('systemctl stop olcrtc || true');
    await s.exec('systemctl disable olcrtc || true');
    await s.exec(`rm -f ${UNIT} ${BIN}`);
    await s.exec(`rm -rf ${CONF_DIR}`);
    await s.exec('systemctl daemon-reload || true');
    await s.exec('userdel olcrtc || true');
  },
});

module.exports = { serverOlcrtc };
