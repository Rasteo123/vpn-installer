const { makeStep } = require('./step');
const { waitFor } = require('./poll');
const { SkippableError } = require('./skippable');
const { loadBinary } = require('../config/olcrtc-assets');
const {
  olcrtcClientYaml,
  olcrtcTunJson,
  olcrtcUnderlayNft,
  olcrtcClientInitd,
  singBoxOlcrtcInitd,
} = require('../config/olcrtc-templates');

const BIN = '/usr/bin/olcrtc';
const CONF_DIR = '/etc/olcrtc';
const KEY_FILE = `${CONF_DIR}/olcrtc.key`;
const TUN_JSON = '/etc/sing-box/olcrtc-tun.json';
const NFT_INCLUDE = '/usr/share/nftables.d/ruleset-post/31-olcrtc-underlay.nft';
const CLIENT_INITD = '/etc/init.d/olcrtc-client';
const SINGBOX_INITD = '/etc/init.d/sing-box-olcrtc';
const SOCKS_PORT = 8808;
const PREFERRED_UID = 45321;

const ARCH_BINARY = { aarch64: 'arm64', x86_64: 'amd64' };

function versionAtLeast(actual, required) {
  const a = String(actual).split('.').map(Number);
  const r = String(required).split('.').map(Number);
  for (let i = 0; i < r.length; i++) {
    if ((a[i] || 0) > (r[i] || 0)) return true;
    if ((a[i] || 0) < (r[i] || 0)) return false;
  }
  return true;
}

// Prefer the well-known id, but take the next free one rather than refusing to
// install when it is already taken by something else.
async function allocateUid(s) {
  const taken = (await s.exec(`awk -F: '$3 == ${PREFERRED_UID} {print $1}' /etc/passwd`)).stdout.trim();
  if (!taken || taken === 'olcrtc') return PREFERRED_UID;

  const free = (await s.exec(
    `for u in $(seq ${PREFERRED_UID + 1} ${PREFERRED_UID + 100}); do `
    + 'if ! awk -F: -v u="$u" \'$3 == u {found=1} END {exit !found}\' /etc/passwd; then echo "$u"; break; fi; done',
  )).stdout.trim();
  if (!free) throw new SkippableError('router.olcrtc: no free uid available for the olcrtc user');
  return parseInt(free, 10);
}

const routerOlcrtc = makeStep({
  id: 'router.olcrtc',
  title: 'olcRTC fallback client (router)',
  target: 'router',

  // Everything that can rule olcRTC out lives here, and every rejection is
  // skippable: the rest of the stack is still worth installing.
  async preflight(ctx) {
    const s = ctx.sessions.router;

    const arch = (await s.exec('uname -m')).stdout.trim();
    if (!ARCH_BINARY[arch]) {
      throw new SkippableError(
        `router.olcrtc: no olcRTC binary is shipped for ${arch} (only aarch64 and x86_64)`,
      );
    }

    const version = ((await s.exec('sing-box version 2>/dev/null')).stdout.match(/(\d+\.\d+\.\d+)/) || [])[1];
    if (!version || !versionAtLeast(version, '1.13.12')) {
      throw new SkippableError(
        `router.olcrtc: sing-box ${version || 'not found'} is too old, 1.13.12 or newer is required`,
      );
    }

    // Prove the firmware can mark packets by uid and that pbr_output exists,
    // then take the probe rule back out.
    const uid = await allocateUid(s);
    await s.exec(
      `nft add rule inet fw4 pbr_output meta skuid ${uid} goto pbr_mark_0x010000 comment "olcrtc-probe" 2>/dev/null || true`,
    );
    const listing = (await s.exec('nft -a list chain inet fw4 pbr_output 2>/dev/null')).stdout;
    const handle = (listing.match(/olcrtc-probe.*?# handle (\d+)/) || [])[1];
    if (handle) {
      await s.exec(`nft delete rule inet fw4 pbr_output handle ${handle}`);
    }
    if (!listing.includes('olcrtc-probe')) {
      throw new SkippableError(
        'router.olcrtc: this firmware cannot mark packets by uid in pbr_output, '
        + 'so the WebRTC underlay would loop back through its own tunnel',
      );
    }

    ctx.results.olcrtcRouter = { uid };
  },

  async execute(ctx) {
    const s = ctx.sessions.router;
    const log = ctx.log || (() => {});
    const { uid } = ctx.results.olcrtcRouter;
    const { roomPrimary, roomSecondary, key } = ctx.results.olcrtc;
    const arch = (await s.exec('uname -m')).stdout.trim();

    log('Installing olcRTC client...');
    await s.exec(
      `grep -q '^olcrtc:' /etc/passwd || echo 'olcrtc:x:${uid}:${uid}:olcRTC:/var/run/olcrtc:/bin/false' >> /etc/passwd`,
    );
    await s.exec(`grep -q '^olcrtc:' /etc/group || echo 'olcrtc:x:${uid}:' >> /etc/group`);
    await s.exec(`mkdir -p ${CONF_DIR} && chmod 750 ${CONF_DIR}`);

    await s.writeFile(BIN, await loadBinary(ARCH_BINARY[arch]), { mode: 0o755 });
    await s.writeFile(KEY_FILE, key, { mode: 0o600 });
    await s.writeFile(
      `${CONF_DIR}/client.yaml`,
      olcrtcClientYaml({ roomPrimary, roomSecondary, socksPort: SOCKS_PORT }),
      { mode: 0o600 },
    );
    await s.exec(`chown -R ${uid}:${uid} ${CONF_DIR}`);

    await s.exec('mkdir -p /etc/sing-box /usr/share/nftables.d/ruleset-post');
    await s.writeFile(TUN_JSON, olcrtcTunJson());
    await s.writeFile(NFT_INCLUDE, olcrtcUnderlayNft({ uid }));

    // Installed but deliberately not enabled: the failover daemon owns when
    // these run.
    await s.writeFile(CLIENT_INITD, olcrtcClientInitd(), { mode: 0o755 });
    await s.writeFile(SINGBOX_INITD, singBoxOlcrtcInitd(), { mode: 0o755 });

    await s.exec('/etc/init.d/firewall reload >/dev/null 2>&1 || true');
  },

  // Bring the stack up once to prove it works, then put it back to sleep.
  // Readiness is condition-based: a live measurement showed SOCKS at ~3s and
  // the tun at ~4s, so the one-shot checks this replaces failed outright.
  async verify(ctx) {
    const s = ctx.sessions.router;
    const t = ctx.timing || {};
    const timeoutMs = t.olcrtcReadyMs ?? 60000;
    const intervalMs = t.pollIntervalMs ?? 2000;

    await s.exec(`${CLIENT_INITD} start`);
    await s.exec(`${SINGBOX_INITD} start`);

    try {
      // waitFor reports the outcome rather than throwing, so the result has to
      // be checked — ignoring it would let verify pass on a tunnel that never
      // came up, which is the one thing this step exists to catch.
      const socksUp = await waitFor(
        async () => (await s.exec(`netstat -tln 2>/dev/null | grep -c '127.0.0.1:${SOCKS_PORT}'`)).stdout.trim() !== '0',
        { timeoutMs, intervalMs },
      );
      if (!socksUp) {
        throw new Error(
          `router.olcrtc: the client never opened SOCKS on 127.0.0.1:${SOCKS_PORT} within ${timeoutMs}ms`,
        );
      }

      const tunUp = await waitFor(
        async () => !!(await s.exec('ip link show tun-olcrtc 2>/dev/null')).stdout.trim(),
        { timeoutMs, intervalMs },
      );
      if (!tunUp) {
        throw new Error(`router.olcrtc: tun-olcrtc never came up within ${timeoutMs}ms`);
      }
    } finally {
      // Lazy activation: whatever happened, the third tier goes back to sleep.
      await s.exec(`${SINGBOX_INITD} stop || true`);
      await s.exec(`${CLIENT_INITD} stop || true`);
    }
  },

  async rollback(ctx) {
    const s = ctx.sessions.router;
    await s.exec(`${SINGBOX_INITD} stop 2>/dev/null || true`);
    await s.exec(`${CLIENT_INITD} stop 2>/dev/null || true`);
    await s.exec(`rm -f ${BIN} ${TUN_JSON} ${NFT_INCLUDE} ${CLIENT_INITD} ${SINGBOX_INITD}`);
    await s.exec(`rm -rf ${CONF_DIR}`);
    await s.exec("sed -i '/^olcrtc:/d' /etc/passwd /etc/group || true");
    await s.exec('/etc/init.d/firewall reload >/dev/null 2>&1 || true');
  },
});

module.exports = { routerOlcrtc };
