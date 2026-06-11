const nodeTest = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const REFERENCE_DIR = path.join(__dirname, '..', '..', 'reference');
const test = (fs.existsSync(REFERENCE_DIR) && fs.readdirSync(REFERENCE_DIR).length > 0) ? nodeTest : nodeTest.skip;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

// Generic secret signatures — intentionally NOT tied to any specific device.
const SECRET_PATTERNS = [
  { name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'unredacted INI key', re: /\b(PrivateKey|PresharedKey)\s*=\s*(?!__REDACTED__)\S/ },
  { name: 'unredacted uci key', re: /option\s+(private_key|preshared_key)\s+'(?!__REDACTED__)[^']+'/ },
  { name: 'unredacted json password', re: /"password"\s*:\s*"(?!__REDACTED__)[^"]+"/ },
  { name: 'wireguard-style base64 key', re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42,43}=(?![A-Za-z0-9+/=])/ },
];

test('reference snapshot exists (run `npm run snapshot` first)', () => {
  const files = walk(REFERENCE_DIR);
  assert.ok(files.length > 0, 'reference/ is empty — run the snapshot tool');
});

test('no captured file leaks a secret', () => {
  for (const file of walk(REFERENCE_DIR)) {
    const body = fs.readFileSync(file, 'utf8');
    for (const { name, re } of SECRET_PATTERNS) {
      assert.ok(!re.test(body), `${name} found in ${path.relative(REFERENCE_DIR, file)}`);
    }
  }
});

// Anything globally routable should have been turned into a token by the
// snapshot redactor. Allow private/doc/loopback/multicast and the health-check.
function octets(ip) { return ip.split('.').map(Number); }
function isAllowlisted(ip) {
  const [a, b] = octets(ip);
  if (a === 10 || a === 127 || a === 0) return true;            // private / loopback / unspecified
  if (a === 192 && b === 168) return true;                      // private
  if (a === 172 && b >= 16 && b <= 31) return true;             // private
  if (a === 169 && b === 254) return true;                      // link-local
  if (a >= 224) return true;                                    // multicast / reserved
  if (ip === '128.0.0.0') return true;                          // split-default route base (0.0.0.0/1 + 128.0.0.0/1)
  if (a === 192 && b === 0) return true;                        // 192.0.2.0/24 doc
  if (a === 198 && b === 51) return true;                       // 198.51.100.0/24 doc
  if (a === 203 && b === 0) return true;                        // 203.0.113.0/24 doc
  // Well-known public resolvers are generic infrastructure, not identifying.
  if (['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9'].includes(ip)) return true;
  return false;
}

test('no captured file leaks a globally-routable IP (must be redacted)', () => {
  // Four dotted octets NOT embedded in a longer dotted-number run, so package
  // versions like 6.6.119.1.0 don't read as IPs.
  const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
  for (const file of walk(REFERENCE_DIR)) {
    const body = fs.readFileSync(file, 'utf8');
    for (const ip of body.match(IPV4) || []) {
      if (octets(ip).some((o) => o > 255)) continue; // not a real IP (e.g. version string)
      assert.ok(isAllowlisted(ip), `unredacted public IP ${ip} in ${path.relative(REFERENCE_DIR, file)}`);
    }
  }
});
