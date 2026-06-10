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
