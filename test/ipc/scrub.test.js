const test = require('node:test');
const assert = require('node:assert');
const { scrub } = require('../../src/main/ipc/handlers');

// Secrets must never travel back to the renderer. The olcRTC key is shared
// between both hosts, so leaking it is worse than leaking a per-host value.
test('scrub removes the olcRTC key while keeping the rooms', () => {
  const out = scrub({
    olcrtc: { roomPrimary: 'a'.repeat(48), roomSecondary: 'b'.repeat(48), key: 'c'.repeat(64) },
  });
  assert.strictEqual(out.olcrtc.key, undefined);
  assert.strictEqual(out.olcrtc.roomPrimary, 'a'.repeat(48));
});

test('scrub still removes the AWG secrets', () => {
  const out = scrub({ awg: { clientPrivateKey: 'x', presharedKey: 'y', address: '10.0.0.2/32' } });
  assert.strictEqual(out.awg.clientPrivateKey, undefined);
  assert.strictEqual(out.awg.presharedKey, undefined);
  assert.strictEqual(out.awg.address, '10.0.0.2/32');
});

test('scrub tolerates missing sections', () => {
  assert.deepStrictEqual(scrub(undefined), {});
  assert.deepStrictEqual(scrub({}), {});
});
