const test = require('node:test');
const assert = require('node:assert');
const { normalize } = require('./diff-helper');

test('normalize strips trailing whitespace and outer blank lines', () => {
  assert.strictEqual(normalize('a  \n b\t\n\n'), 'a\n b');
  assert.strictEqual(normalize('\n\nx\n'), 'x');
});
