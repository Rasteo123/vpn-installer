const test = require('node:test');
const assert = require('node:assert');
const { redactValues } = require('../../src/main/snapshot/redact');

test('replaces every occurrence of known device values with tokens', () => {
  const input = 'endpoint 198.51.100.7:443 and again 198.51.100.7';
  const out = redactValues(input, { '198.51.100.7': '__VPS_IP__' });
  assert.strictEqual(out, 'endpoint __VPS_IP__:443 and again __VPS_IP__');
});

test('ignores empty values in the map', () => {
  const input = 'unchanged text';
  const out = redactValues(input, { '': '__NOPE__', 'absent': '__X__' });
  assert.strictEqual(out, 'unchanged text');
});

const { redactFields } = require('../../src/main/snapshot/redact');

test('masks INI secret fields (AWG conf)', () => {
  const out = redactFields('PrivateKey = abc123XYZ=\nMTU = 1280');
  assert.match(out, /PrivateKey = __REDACTED__/);
  assert.match(out, /MTU = 1280/); // non-secret untouched
});

test('masks uci secret options', () => {
  const out = redactFields("option private_key 'SECRETKEYVALUE='\n\toption mtu '1280'");
  assert.match(out, /option private_key '__REDACTED__'/);
  assert.match(out, /option mtu '1280'/);
});

test('masks JSON secret fields', () => {
  const out = redactFields('{"password": "p@ss", "server_name": "ex.com"}');
  assert.match(out, /"password":\s*"__REDACTED__"/);
  assert.match(out, /"server_name":\s*"ex.com"/); // non-secret untouched
});

test('masks per-install public keys (uci + ini)', () => {
  assert.match(redactFields("option public_key 'Fv5z0GKzIp1='"), /option public_key '__REDACTED__'/);
  assert.match(redactFields('PublicKey = 0hN6wwg='), /PublicKey = __REDACTED__/);
});
