const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PATH = path.join(os.homedir(), '.vpn-installer', 'known_hosts.json');

// OpenSSH-style fingerprint of a raw host key blob: SHA256:<base64, no padding>.
function fingerprint(keyBlob) {
  const hash = crypto.createHash('sha256').update(keyBlob).digest('base64').replace(/=+$/, '');
  return `SHA256:${hash}`;
}

// Tiny TOFU store: { "host:port": "SHA256:..." } in a 0600 JSON file.
class KnownHosts {
  constructor(filePath = DEFAULT_PATH) {
    this.filePath = filePath;
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  get(host, port) {
    return this._load()[`${host}:${port}`] || null;
  }

  remember(host, port, keyBlob) {
    const data = this._load();
    data[`${host}:${port}`] = fingerprint(keyBlob);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  }
}

// Trust-on-first-use check. First sighting is stored and trusted; afterwards
// the key must match or the connection is refused.
function verifyHostKey(store, host, port, keyBlob) {
  const fp = fingerprint(keyBlob);
  const expected = store.get(host, port);
  if (!expected) {
    store.remember(host, port, keyBlob);
    return { ok: true, status: 'first-use', fingerprint: fp };
  }
  if (expected === fp) {
    return { ok: true, status: 'match', fingerprint: fp };
  }
  return { ok: false, status: 'mismatch', fingerprint: fp, expected };
}

module.exports = { KnownHosts, fingerprint, verifyHostKey, DEFAULT_PATH };
