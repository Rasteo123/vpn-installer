const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { createInstallContext } = require('../../src/main/context');
const { serverOlcrtc } = require('../../src/main/steps/server-olcrtc');

const KEY = 'a'.repeat(64);

function makeCtx(s) {
  const ctx = createInstallContext({ vps: { host: '203.0.113.9', privateKey: 'x', auth: 'key' } });
  ctx.sessions.vps = s;
  return ctx;
}

function okSession(overrides = {}) {
  return new FakeSSHSession({
    'uname -m': { stdout: 'x86_64\n' },
    'command -v systemctl': { stdout: '/usr/bin/systemctl\n' },
    'cat /etc/olcrtc/olcrtc.key': { stdout: `${KEY}\n` },
    'systemctl is-active olcrtc': { stdout: 'active\n' },
    ...overrides,
  });
}

test('server.olcrtc preflight rejects a non-x86_64 VPS', async () => {
  const ctx = makeCtx(okSession({ 'uname -m': { stdout: 'armv7l\n' } }));
  await assert.rejects(serverOlcrtc.preflight(ctx), /x86_64/);
});

test('server.olcrtc preflight rejects a VPS without systemd', async () => {
  const ctx = makeCtx(okSession({ 'command -v systemctl': { stdout: '' } }));
  await assert.rejects(serverOlcrtc.preflight(ctx), /systemd/);
});

test('server.olcrtc installs the binary, config and unit, and records the rooms', async () => {
  const s = okSession();
  const ctx = makeCtx(s);

  await serverOlcrtc.execute(ctx);

  assert.ok(Buffer.isBuffer(s.written['/usr/local/bin/olcrtc']), 'binary must be written as bytes');
  assert.match(s.written['/etc/olcrtc/server.yaml'], /^mode: srv$/m);
  assert.match(s.written['/etc/systemd/system/olcrtc.service'], /ExecStart=\/usr\/local\/bin\/olcrtc/);
  assert.match(ctx.results.olcrtc.roomPrimary, /^[0-9a-f]{48}$/);
  assert.strictEqual(ctx.results.olcrtc.key, KEY);
});

// The key must be generated on the server so it never appears in a command
// line, the same rule the AWG keys already follow.
test('server.olcrtc generates the key on the server, never passing it as an argument', async () => {
  const s = okSession();
  const ctx = makeCtx(s);

  await serverOlcrtc.execute(ctx);

  assert.ok(s.execed.some((c) => c.includes('openssl rand -hex 32')), 'expected the key to be generated remotely');
  assert.ok(!s.execed.some((c) => c.includes(KEY)), 'key must never appear in a command');
  assert.strictEqual(s.modes['/etc/olcrtc/server.yaml'], 0o600);
});

// Re-running against a server that already runs this build must not restart the
// tunnel of someone already using it — and the router step still needs the key
// and rooms, so they are adopted rather than regenerated.
test('server.olcrtc isApplied adopts an existing install and recovers its rooms and key', async () => {
  const yaml = [
    'mode: srv',
    'profiles:',
    '  - name: jitsi-primary',
    '    room:',
    `      id: "https://conference.ct.placetime.team/${'1'.repeat(48)}"`,
    '  - name: jitsi-secondary',
    '    room:',
    `      id: "https://meet.mamba.group/${'2'.repeat(48)}"`,
  ].join('\n');
  const s = okSession({ 'cat /etc/olcrtc/server.yaml': { stdout: yaml } });
  const ctx = makeCtx(s);

  assert.strictEqual(await serverOlcrtc.isApplied(ctx), true);
  assert.strictEqual(ctx.results.olcrtc.roomPrimary, '1'.repeat(48));
  assert.strictEqual(ctx.results.olcrtc.roomSecondary, '2'.repeat(48));
  assert.strictEqual(ctx.results.olcrtc.key, KEY);
});

test('server.olcrtc isApplied is false when the unit is not running', async () => {
  const ctx = makeCtx(okSession({ 'systemctl is-active olcrtc': { stdout: 'inactive\n' } }));
  assert.strictEqual(await serverOlcrtc.isApplied(ctx), false);
});

test('server.olcrtc verify fails when the unit is not active', async () => {
  const ctx = makeCtx(okSession({ 'systemctl is-active olcrtc': { stdout: 'failed\n' } }));
  await assert.rejects(serverOlcrtc.verify(ctx), /not active/);
});

test('server.olcrtc rollback stops the unit and removes its files', async () => {
  const s = okSession();
  await serverOlcrtc.rollback(makeCtx(s));
  const all = s.execed.join('\n');
  assert.match(all, /systemctl stop olcrtc/);
  assert.match(all, /systemctl disable olcrtc/);
  assert.match(all, /rm -rf \/etc\/olcrtc/);
});
