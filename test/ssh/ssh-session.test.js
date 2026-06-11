const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const SSHSession = require('../../src/main/ssh/SSHSession');
const { KnownHosts, fingerprint } = require('../../src/main/ssh/known-hosts');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpn-ssh-'));
  return new KnownHosts(path.join(dir, 'known_hosts.json'));
}

const KEY_A = Buffer.from('host-key-A');
const KEY_B = Buffer.from('host-key-B');

test('host verifier trusts first use, then rejects a changed key with a clear error', () => {
  const s = new SSHSession({ knownHosts: tmpStore() });

  const verify1 = s._makeHostVerifier('198.51.100.7', 22);
  assert.strictEqual(verify1(KEY_A), true);
  assert.strictEqual(s._hostKeyError, null);

  const verify2 = s._makeHostVerifier('198.51.100.7', 22);
  assert.strictEqual(verify2(KEY_B), false);
  assert.ok(s._hostKeyError instanceof Error);
  assert.match(s._hostKeyError.message, /198\.51\.100\.7/);
  assert.match(s._hostKeyError.message, new RegExp(fingerprint(KEY_B).replace(/[+/]/g, '.')));
  assert.match(s._hostKeyError.message, /known_hosts\.json/);
});

// Stub of an ssh2 connection whose exec stream never closes — only our
// timeout logic can end the call.
function hangingConn() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = false;
  stream.close = () => { stream.closed = true; };
  return {
    stream,
    exec(cmd, cb) { cb(null, stream); },
  };
}

test('exec honors a custom timeoutMs and closes the channel', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = hangingConn();
  s.conn = conn;
  s.connected = true;

  await assert.rejects(
    s.exec('apt-get install everything', { timeoutMs: 50 }),
    /timed out/,
  );
  assert.strictEqual(conn.stream.closed, true);
});

test('execStream honors a custom timeoutMs', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  s.conn = hangingConn();
  s.connected = true;
  await assert.rejects(
    s.execStream('opkg install world', () => {}, { timeoutMs: 50 }),
    /timed out/,
  );
});
