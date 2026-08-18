const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const SOURCE_ASSETS = path.join(__dirname, 'assets', 'olcrtc');

// Packaged builds get the binaries as extraResources; a dev run reads them
// straight out of the source tree.
function resolveOlcrtcAssets({ isPackaged, resourcesPath } = {}) {
  const root = isPackaged ? path.join(resourcesPath, 'olcrtc') : SOURCE_ASSETS;
  return {
    root,
    manifest: path.join(root, 'SHA256SUMS'),
    amd64Gz: path.join(root, 'olcrtc-linux-amd64.gz'),
    arm64Gz: path.join(root, 'olcrtc-linux-arm64.gz'),
  };
}

function parseManifest(content) {
  const hashes = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(\S+)$/);
    if (match) hashes.set(match[2], match[1]);
  }
  return hashes;
}

// Decompress and verify before the bytes are allowed anywhere near a host.
// Downloading these at install time is not an option: this tool is used
// precisely when outside sources are unreachable.
async function loadBinary(arch, assets = resolveOlcrtcAssets({ isPackaged: false })) {
  const name = `olcrtc-linux-${arch}`;
  const gz = { amd64: assets.amd64Gz, arm64: assets.arm64Gz }[arch];
  if (!gz) throw new Error(`olcrtc: unsupported architecture ${arch}`);

  const buf = await gunzip(await fs.readFile(gz));
  const expected = parseManifest(await fs.readFile(assets.manifest, 'utf8')).get(name);
  if (!expected) throw new Error(`olcrtc: ${name} is missing from the manifest`);

  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) {
    throw new Error(`olcrtc: ${name} hash mismatch (${actual} != ${expected})`);
  }
  return buf;
}

module.exports = { resolveOlcrtcAssets, parseManifest, loadBinary };
