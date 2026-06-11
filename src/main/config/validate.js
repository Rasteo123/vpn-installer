// Input validation at the trust boundary (UI fields, env vars). These values
// end up inside root shell commands and configs on the VPS/router, so the
// charset is strict — no quoting tricks, just refuse anything unusual.

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f:]{2,45}$/i;
const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/;

function isIpv4(s) {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

// IPv4, IPv6 or hostname. Returns the trimmed value or throws.
function assertHost(value, label = 'host') {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new Error(`${label}: пустое значение`);
  if (v.length > 253) throw new Error(`${label}: слишком длинное значение`);
  if (isIpv4(v)) return v;
  if (v.includes(':')) {
    if (IPV6_RE.test(v)) return v;
    throw new Error(`${label}: недопустимый адрес '${v}'`);
  }
  if (HOSTNAME_RE.test(v)) return v;
  throw new Error(`${label}: недопустимый адрес или имя хоста '${v}'`);
}

// FQDN with at least one dot and an alphabetic-start TLD (rules out bare IPs).
// Returns the trimmed, lowercased value or throws.
function assertDomain(value, label = 'domain') {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) throw new Error(`${label}: пустое значение`);
  if (v.length > 253) throw new Error(`${label}: слишком длинное значение`);
  if (!DOMAIN_RE.test(v)) {
    throw new Error(`${label}: ожидается домен вида vpn.example.com, получено '${v}'`);
  }
  return v;
}

function assertPort(value, label = 'port') {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${label}: ожидается порт 1-65535, получено '${value}'`);
  }
  return n;
}

module.exports = { assertHost, assertDomain, assertPort };
