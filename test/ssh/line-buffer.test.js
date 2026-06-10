const test = require('node:test');
const assert = require('node:assert');
const { takeLines } = require('../../src/main/ssh/line-buffer');

test('splits complete lines and keeps the remainder', () => {
  const { lines, remainder } = takeLines('alpha\nbeta\ngamm');
  assert.deepStrictEqual(lines, ['alpha', 'beta']);
  assert.strictEqual(remainder, 'gamm');
});

test('no newline yields no lines and full remainder', () => {
  const { lines, remainder } = takeLines('partial');
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(remainder, 'partial');
});

test('trailing newline yields empty remainder', () => {
  const { lines, remainder } = takeLines('a\nb\n');
  assert.deepStrictEqual(lines, ['a', 'b']);
  assert.strictEqual(remainder, '');
});
