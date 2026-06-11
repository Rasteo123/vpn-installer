const test = require('node:test');
const assert = require('node:assert');
const { FakeSSHSession } = require('../ssh/fake-session');
const { ufwActive, openUfwPorts, closeUfwPorts } = require('../../src/main/steps/ufw');

test('ufwActive is true only when status reports active', async () => {
  const on = new FakeSSHSession({ 'ufw status': { stdout: 'Status: active\n' } });
  const off = new FakeSSHSession({ 'ufw status': { stdout: 'Status: inactive\n' } });
  const missing = new FakeSSHSession(); // ufw not installed -> empty
  assert.strictEqual(await ufwActive(on), true);
  assert.strictEqual(await ufwActive(off), false);
  assert.strictEqual(await ufwActive(missing), false);
});

test('openUfwPorts opens ports only when ufw is active and reports what it added', async () => {
  const s = new FakeSSHSession({ 'ufw status': { stdout: 'Status: active\n' } });
  const added = await openUfwPorts(s, ['443/udp', '2053/tcp']);
  assert.deepStrictEqual(added, ['443/udp', '2053/tcp']);
  assert.ok(s.execed.some((c) => c.includes('ufw allow 443/udp')));
  assert.ok(s.execed.some((c) => c.includes('ufw allow 2053/tcp')));
});

test('openUfwPorts is a no-op when ufw is inactive', async () => {
  const s = new FakeSSHSession({ 'ufw status': { stdout: 'Status: inactive\n' } });
  const added = await openUfwPorts(s, ['443/udp']);
  assert.deepStrictEqual(added, []);
  assert.ok(!s.execed.some((c) => c.includes('ufw allow')));
});

test('closeUfwPorts deletes the given rules tolerantly', async () => {
  const s = new FakeSSHSession();
  await closeUfwPorts(s, ['443/udp']);
  assert.ok(s.execed.some((c) => c.includes('ufw delete allow 443/udp')));
});
