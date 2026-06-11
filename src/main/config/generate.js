const crypto = require('crypto');

// crypto-random integer in [min, max] inclusive.
function randInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

// AmneziaWG obfuscation parameters, randomized per install so installs of this
// tool don't share a DPI fingerprint. Server and client must use the SAME set —
// both read it from ctx.results.awg. Bounds follow the AWG recommendations and
// the proven reference set:
//   - S2 != S1+56, otherwise init (148+S1) and response (92+S2) packets collide;
//   - H1-H4 are non-overlapping ranges (AWG 2.0 picks a value per handshake);
//   - S3/S4/I1 stay at the reference values: I1 is a protocol-mimicry payload
//     (DNS-response shape) where random bytes would stand out more, not less.
function generateObfuscation() {
  const jc = randInt(4, 8);
  const jmin = randInt(40, 60);
  const jmax = jmin + randInt(30, 60);
  const s1 = randInt(15, 120);
  let s2 = randInt(15, 150);
  while (s2 === s1 + 56) s2 = randInt(15, 150);

  const width = 1000;
  const bases = [];
  while (bases.length < 4) {
    const b = randInt(5, 0x7fffffff - width - 1);
    if (bases.every((x) => Math.abs(x - b) > width)) bases.push(b);
  }
  const [h1, h2, h3, h4] = bases.map((b) => `${b}-${b + width}`);

  return {
    jc, jmin, jmax, s1, s2, s3: 196, s4: 88,
    h1, h2, h3, h4,
    i1: '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>',
  };
}

// Random per-install credentials for NaiveProxy.
function generateNaiveCreds() {
  return {
    username: 'user_' + crypto.randomBytes(8).toString('hex'),
    password: crypto.randomBytes(18).toString('base64url'),
  };
}

module.exports = { generateObfuscation, generateNaiveCreds };
