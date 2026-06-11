const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('./fake-session');

test('returns canned output for a matching command substring', async () => {
  const s = new FakeSSHSession({ 'uci export network': { stdout: 'config interface', code: 0 } });
  const res = await s.exec('uci export network 2>/dev/null');
  assert.strictEqual(res.stdout, 'config interface');
  assert.strictEqual(res.code, 0);
});

test('records executed commands and written files', async () => {
  const s = new FakeSSHSession();
  await s.exec('echo hi');
  await s.writeFile('/etc/x.conf', 'body');
  assert.ok(s.execed.includes('echo hi'));
  assert.strictEqual(s.written['/etc/x.conf'], 'body');
  assert.strictEqual(await s.readFile('/etc/x.conf'), 'body');
  assert.strictEqual(await s.exists('/etc/x.conf'), true);
});

test('unmatched command returns empty success', async () => {
  const s = new FakeSSHSession();
  const res = await s.exec('whatever');
  assert.deepStrictEqual(res, { stdout: '', stderr: '', code: 0 });
});

test('writeFile records an explicit mode for secret files', async () => {
  const s = new FakeSSHSession();
  await s.writeFile('/etc/secret.conf', 'body', { mode: 0o600 });
  assert.strictEqual(s.modes['/etc/secret.conf'], 0o600);
  await s.writeFile('/etc/plain.conf', 'body');
  assert.strictEqual(s.modes['/etc/plain.conf'], undefined);
});
