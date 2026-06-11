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

test('generateObfuscation randomizes junk/header params within safe AWG bounds', () => {
  for (let i = 0; i < 50; i++) {
    const o = generateObfuscation();
    assert.ok(o.jc >= 3 && o.jc <= 10, `jc out of range: ${o.jc}`);
    assert.ok(o.jmin >= 40 && o.jmin <= 60, `jmin out of range: ${o.jmin}`);
    assert.ok(o.jmax > o.jmin && o.jmax <= o.jmin + 60, `jmax out of range: ${o.jmax}`);
    assert.ok(o.s1 >= 15 && o.s1 <= 120, `s1 out of range: ${o.s1}`);
    assert.ok(o.s2 >= 15 && o.s2 <= 150, `s2 out of range: ${o.s2}`);
    assert.notStrictEqual(o.s2, o.s1 + 56, 'S2 must not equal S1+56 (init/response size collision)');

    const ranges = [o.h1, o.h2, o.h3, o.h4].map((h) => {
      const m = /^(\d+)-(\d+)$/.exec(h);
      assert.ok(m, `header is not a range: ${h}`);
      const lo = Number(m[1]), hi = Number(m[2]);
      assert.ok(lo >= 5 && hi > lo && hi <= 0x7fffffff, `header range out of bounds: ${h}`);
      return [lo, hi];
    });
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) {
        const overlap = ranges[a][0] <= ranges[b][1] && ranges[b][0] <= ranges[a][1];
        assert.ok(!overlap, `header ranges overlap: ${ranges[a]} vs ${ranges[b]}`);
      }
    }
  }
});

test('generateObfuscation differs between installs (no shared fingerprint)', () => {
  const a = generateObfuscation();
  const b = generateObfuscation();
  assert.notStrictEqual(a.h1, b.h1);
  assert.notDeepStrictEqual([a.h1, a.h2, a.h3, a.h4], [b.h1, b.h2, b.h3, b.h4]);
});

test('generateNaiveCreds returns a username and random password', () => {
  const c = generateNaiveCreds();
  assert.match(c.username, /^user_[0-9a-f]{16}$/);
  assert.ok(c.password.length >= 20);
  assert.notStrictEqual(c.password, generateNaiveCreds().password);
});
