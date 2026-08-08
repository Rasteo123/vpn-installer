const test = require('node:test');
const assert = require('node:assert');
const { waitFor } = require('../../src/main/steps/poll');

test('waitFor returns true as soon as the check passes', async () => {
  let calls = 0;
  const ok = await waitFor(async () => { calls += 1; return calls >= 3; }, { timeoutMs: 500, intervalMs: 5 });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls, 3);
});

test('waitFor returns false when the check never passes within the timeout', async () => {
  const ok = await waitFor(async () => false, { timeoutMs: 30, intervalMs: 5 });
  assert.strictEqual(ok, false);
});
