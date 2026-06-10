const test = require('node:test');
const assert = require('node:assert');
const { VPS_CAPTURES, ROUTER_CAPTURES } = require('../../src/main/snapshot/manifest');

function validate(list) {
  assert.ok(Array.isArray(list) && list.length > 0);
  const outs = new Set();
  for (const entry of list) {
    assert.ok(entry.cmd && typeof entry.cmd === 'string', 'cmd is a non-empty string');
    assert.ok(entry.out && typeof entry.out === 'string', 'out is a non-empty string');
    assert.ok(!entry.out.startsWith('/'), 'out is a relative path');
    assert.ok(!outs.has(entry.out), `out path is unique: ${entry.out}`);
    outs.add(entry.out);
  }
}

test('VPS captures are well-formed and unique', () => validate(VPS_CAPTURES));
test('router captures are well-formed and unique', () => validate(ROUTER_CAPTURES));
