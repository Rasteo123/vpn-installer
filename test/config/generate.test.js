const test = require('node:test');
const assert = require('node:assert');
const { generateObfuscation, generateNaiveCreds } = require('../../src/main/config/generate');

test('generateObfuscation returns a complete AWG param set', () => {
  const o = generateObfuscation();
  for (const k of ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'i1']) {
    assert.ok(o[k] !== undefined, `missing ${k}`);
  }
  assert.ok(o.jmax > o.jmin);
});

test('generateNaiveCreds returns a username and random password', () => {
  const c = generateNaiveCreds();
  assert.match(c.username, /^user_[0-9a-f]{16}$/);
  assert.ok(c.password.length >= 20);
  assert.notStrictEqual(c.password, generateNaiveCreds().password);
});
