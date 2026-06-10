// Replace exact known device-identifying strings with stable tokens.
function redactValues(content, valueMap) {
  let out = String(content);
  for (const [value, token] of Object.entries(valueMap)) {
    if (!value) continue;
    out = out.split(value).join(token);
  }
  return out;
}

const DEFAULT_SECRET_FIELDS = [
  'PrivateKey', 'PublicKey', 'PresharedKey',     // AWG ini (public key is per-install too)
  'private_key', 'public_key', 'preshared_key',  // uci
  'password', 'uuid', 'privateKey',              // json
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mask values of named secret fields across INI, uci, and JSON.
function redactFields(content, fields = DEFAULT_SECRET_FIELDS, token = '__REDACTED__') {
  let out = String(content);
  for (const f of fields) {
    const fe = escapeRe(f);
    // INI:  Field = value
    out = out.replace(new RegExp(`(^|\\n)(\\s*${fe}\\s*=\\s*).*`, 'g'), `$1$2${token}`);
    // uci:  option field 'value'
    out = out.replace(new RegExp(`(option\\s+${fe}\\s+')[^']*(')`, 'g'), `$1${token}$2`);
    // json: "field": "value"
    out = out.replace(new RegExp(`("${fe}"\\s*:\\s*")[^"]*(")`, 'g'), `$1${token}$2`);
  }
  return out;
}

module.exports = { redactValues, redactFields, DEFAULT_SECRET_FIELDS };
