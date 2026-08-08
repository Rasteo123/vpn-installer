const test = require('node:test');
const assert = require('node:assert');
const { assertHost, assertIpv4, assertDomain, assertPort } = require('../../src/main/config/validate');

test('assertHost accepts IPv4, hostnames and IPv6, and trims', () => {
  assert.strictEqual(assertHost(' 203.0.113.9 '), '203.0.113.9');
  assert.strictEqual(assertHost('vpn.example.com'), 'vpn.example.com');
  assert.strictEqual(assertHost('2001:db8::1'), '2001:db8::1');
});

test('assertHost rejects shell metacharacters and junk', () => {
  for (const bad of ['1.2.3.4; rm -rf /', 'host name', "x'y", 'a$(reboot)', '', '   ', 'host`id`', 'a&&b', '-leading.dash']) {
    assert.throws(() => assertHost(bad), /host/i, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('assertIpv4 accepts only a literal IPv4 address and trims', () => {
  assert.strictEqual(assertIpv4(' 203.0.113.9 '), '203.0.113.9');
  for (const bad of ['vpn.example.com', '2001:db8::1', '999.1.1.1', '1.2.3', '1.2.3.4;id', '1.2.3.4 5']) {
    assert.throws(() => assertIpv4(bad, 'VPS host'), /IPv4/i, `should reject: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => assertIpv4('', 'VPS host'), /пустое/, 'empty value gets the standard empty-value message');
});

test('assertDomain accepts a normal FQDN and lowercases it', () => {
  assert.strictEqual(assertDomain('VPN.Example.COM '), 'vpn.example.com');
  assert.strictEqual(assertDomain('xn--80ak6aa92e.com'), 'xn--80ak6aa92e.com');
});

test('assertDomain rejects bare labels, IPs and injection attempts', () => {
  for (const bad of ['localhost', '203.0.113.9', 'ex ample.com', 'ex.com;id', 'a..com', '', '.com', 'ex.com$(x)']) {
    assert.throws(() => assertDomain(bad), /domain|домен/i, `should reject: ${JSON.stringify(bad)}`);
  }
});

test('assertPort accepts 1-65535 and rejects everything else', () => {
  assert.strictEqual(assertPort(22), 22);
  assert.strictEqual(assertPort('2222'), 2222);
  for (const bad of [0, -1, 65536, 1.5, 'abc', NaN, '22; ls']) {
    assert.throws(() => assertPort(bad), /port/i, `should reject: ${JSON.stringify(bad)}`);
  }
});
