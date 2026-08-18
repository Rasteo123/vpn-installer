const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');
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

// Stub of an ssh2 connection with no SFTP subsystem (Dropbear on OpenWrt),
// backed by a tiny in-memory filesystem so the test verifies the bytes that
// actually arrive rather than just the commands issued.
function sftplessConn() {
  const parts = {};
  const files = {};
  const commands = [];

  function respond(cmd) {
    let m;
    if ((m = cmd.match(/^: > '(.+)\.part'$/))) { parts[m[1]] = ''; return ''; }
    if ((m = cmd.match(/^printf '%s' '([A-Za-z0-9+/=]*)' >> '(.+)\.part'$/))) {
      parts[m[2]] += m[1];
      return '';
    }
    if ((m = cmd.match(/^base64 -d '(.+)\.part' > '(.+?)'/))) {
      files[m[2]] = Buffer.from(parts[m[1]] || '', 'base64');
      return '';
    }
    if ((m = cmd.match(/^wc -c < '(.+)'$/))) return String((files[m[1]] || Buffer.alloc(0)).length);
    if ((m = cmd.match(/^sha256sum '(.+?)'/))) {
      return crypto.createHash('sha256').update(files[m[1]] || Buffer.alloc(0)).digest('hex');
    }
    return '';
  }

  return {
    files,
    commands,
    sftp(cb) { cb(new Error('Channel open failure: unknown channel type')); },
    exec(cmd, cb) {
      commands.push(cmd);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      setImmediate(() => {
        const out = respond(cmd);
        if (out) stream.emit('data', Buffer.from(out + '\n'));
        stream.emit('close', 0);
      });
      cb(null, stream);
    },
  };
}

test('writeFile falls back to exec when SFTP is unavailable and transfers exact bytes', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = sftplessConn();
  s.conn = conn;
  s.connected = true;

  const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x27, 0x41]);
  await s.writeFile('/etc/olcrtc/blob.bin', payload);

  assert.deepStrictEqual(conn.files['/etc/olcrtc/blob.bin'], payload);
  assert.strictEqual(s._sftpUnavailable, true);
});

test('writeFile applies mode over the exec fallback', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = sftplessConn();
  s.conn = conn;
  s.connected = true;

  await s.writeFile('/etc/olcrtc/olcrtc.key', 'secret-key-material', { mode: 0o600 });

  assert.ok(conn.commands.some((c) => c === "chmod 600 '/etc/olcrtc/olcrtc.key'"));
});

test('writeFile handles empty content over the exec fallback', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = sftplessConn();
  s.conn = conn;
  s.connected = true;

  await s.writeFile('/tmp/empty', '');

  assert.deepStrictEqual(conn.files['/tmp/empty'], Buffer.alloc(0));
});

test('writeFile rejects when the remote file does not match the source bytes', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = sftplessConn();
  // Corrupt the transfer: swallow every appended chunk so the file ends empty.
  const realExec = conn.exec;
  conn.exec = (cmd, cb) => realExec(cmd.startsWith("printf '%s'") ? "true" : cmd, cb);
  s.conn = conn;
  s.connected = true;

  await assert.rejects(s.writeFile('/tmp/x', 'some content'), /size mismatch|checksum mismatch/);
});
