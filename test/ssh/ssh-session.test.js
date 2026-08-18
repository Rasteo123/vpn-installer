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
// backed by a tiny in-memory filesystem. Payload commands receive raw bytes on
// stdin; everything else answers immediately, like a normal exec.
function sftplessConn({ missing = [] } = {}) {
  const files = {};
  const commands = [];

  return {
    files,
    commands,
    sftp(cb) { cb(new Error('Channel open failure: unknown channel type')); },
    exec(cmd, cb) {
      commands.push(cmd);
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};

      const prog = cmd.trim().split(/\s+/)[0];
      if (missing.includes(prog)) {
        // The payload is still written to stdin before the shell reports 127.
        stream.write = () => true;
        stream.end = () => {};
        setImmediate(() => {
          stream.stderr.emit('data', Buffer.from(`ash: ${prog}: not found\n`));
          stream.emit('close', 127);
        });
        return cb(null, stream);
      }

      const write = cmd.match(/^cat > '(.+)'$/);
      if (write) {
        let stdin = Buffer.alloc(0);
        stream.write = (chunk) => { stdin = Buffer.concat([stdin, Buffer.from(chunk)]); return true; };
        stream.end = (chunk) => {
          if (chunk) stdin = Buffer.concat([stdin, Buffer.from(chunk)]);
          files[write[1]] = stdin;
          setImmediate(() => stream.emit('close', 0));
        };
        return cb(null, stream);
      }

      setImmediate(() => {
        let m;
        let out = '';
        if ((m = cmd.match(/^wc -c < '(.+)'$/))) {
          out = String((files[m[1]] || Buffer.alloc(0)).length);
        } else if ((m = cmd.match(/^sha256sum '(.+?)'/))) {
          out = crypto.createHash('sha256').update(files[m[1]] || Buffer.alloc(0)).digest('hex');
        }
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

// Found on a live router: this firmware's busybox ships no `base64` applet, so
// the old encoded transfer silently produced an empty file. A non-zero exit
// must fail loudly and name the command.
test('writeFile fails loudly when the remote command is missing', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  s.conn = sftplessConn({ missing: ['cat'] });
  s.connected = true;

  await assert.rejects(s.writeFile('/tmp/x', 'some content'), /exit 127|not found/);
});

test('writeFile rejects when the remote file does not match the source bytes', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  const conn = sftplessConn();
  // Corrupt the transfer: swallow the payload on its way in.
  const realExec = conn.exec;
  conn.exec = (cmd, cb) => realExec(cmd, (e, stream) => {
    if (cmd.startsWith('cat > ')) {
      const end = stream.end;
      stream.end = () => end.call(stream, null);
    }
    cb(e, stream);
  });
  s.conn = conn;
  s.connected = true;

  await assert.rejects(s.writeFile('/tmp/x', 'some content'), /size mismatch|checksum mismatch/);
});

// Measured against a real router: ssh2 leaves the channel paused until stdout
// has a consumer, so a write with no reader never closes. Without a timeout
// the installer hangs forever instead of failing.
function hangingWriteConn() {
  return {
    sftp(cb) { cb(new Error('no sftp')); },
    exec(cmd, cb) {
      const stream = new EventEmitter();
      stream.stderr = new EventEmitter();
      stream.close = () => {};
      stream.write = () => true;
      stream.end = () => {};
      cb(null, stream);
    },
  };
}

test('writeFile times out instead of hanging when the channel never closes', async () => {
  const s = new SSHSession({ knownHosts: tmpStore() });
  s.conn = hangingWriteConn();
  s.connected = true;

  await assert.rejects(s.writeFile('/tmp/x', 'payload', { timeoutMs: 100 }), /timed out/);
});
