const crypto = require('crypto');

// AmneziaWG obfuscation parameters. v1 uses the proven reference set (server and
// client must use the SAME set). Per-install randomization is a future enhancement.
function generateObfuscation() {
  return {
    jc: 6, jmin: 48, jmax: 96, s1: 64, s2: 132, s3: 196, s4: 88,
    h1: '241345077-241346077', h2: '890624709-890625709',
    h3: '1480064884-1480065884', h4: '1935204763-1935205763',
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
