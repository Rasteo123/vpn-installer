const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KnownHosts, fingerprint, verifyHostKey } = require('../../src/main/ssh/known-hosts');

function tmpStorePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-kh-'));
  return path.join(dir, 'nested', 'known_hosts.json');
}

const KEY_A = Buffer.from('ssh-ed25519-key-material-AAAA');
const KEY_B = Buffer.from('ssh-ed25519-key-material-BBBB');

test('fingerprint matches OpenSSH SHA256 format (base64, no padding)', () => {
  const fp = fingerprint(KEY_A);
  assert.match(fp, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.strictEqual(fp, fingerprint(KEY_A));
  assert.notStrictEqual(fp, fingerprint(KEY_B));
});

test('first connect is trusted and remembered (TOFU)', () => {
  const file = tmpStorePath();
  const kh = new KnownHosts(file);
  const res = verifyHostKey(kh, '198.51.100.7', 22, KEY_A);
  assert.deepStrictEqual(
    { ok: res.ok, status: res.status },
    { ok: true, status: 'first-use' },
  );
  // A fresh store reading the same file now recognizes the key.
  const again = verifyHostKey(new KnownHosts(file), '198.51.100.7', 22, KEY_A);
  assert.deepStrictEqual({ ok: again.ok, status: again.status }, { ok: true, status: 'match' });
});

test('store file is created with 0600 permissions', () => {
  const file = tmpStorePath();
  verifyHostKey(new KnownHosts(file), '198.51.100.7', 22, KEY_A);
  const mode = fs.statSync(file).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('a different key for a known host is rejected and not overwritten', () => {
  const file = tmpStorePath();
  const kh = new KnownHosts(file);
  verifyHostKey(kh, '198.51.100.7', 22, KEY_A);
  const res = verifyHostKey(kh, '198.51.100.7', 22, KEY_B);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.status, 'mismatch');
  assert.strictEqual(res.expected, fingerprint(KEY_A));
  assert.strictEqual(res.fingerprint, fingerprint(KEY_B));
  // Original key still trusted, attacker key still rejected after reload.
  const reload = new KnownHosts(file);
  assert.strictEqual(verifyHostKey(reload, '198.51.100.7', 22, KEY_A).ok, true);
  assert.strictEqual(verifyHostKey(reload, '198.51.100.7', 22, KEY_B).ok, false);
});

test('same host on a different port is a separate entry', () => {
  const file = tmpStorePath();
  const kh = new KnownHosts(file);
  verifyHostKey(kh, '198.51.100.7', 22, KEY_A);
  const res = verifyHostKey(kh, '198.51.100.7', 2222, KEY_B);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'first-use');
});

test('corrupted store file is treated as empty, not a crash', () => {
  const file = tmpStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  const res = verifyHostKey(new KnownHosts(file), '198.51.100.7', 22, KEY_A);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.status, 'first-use');
});
