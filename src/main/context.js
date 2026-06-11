const { assertHost, assertDomain, assertPort } = require('./config/validate');

// Single shared state object for an install run. Device-specific values come
// only from `inputs`; `results` is filled by steps and returned to the UI.
// Hosts/domain/ports are validated here because they end up inside root
// shell commands on the VPS and the router.
function createInstallContext(input = {}) {
  const vps = input.vps || {};
  const router = input.router || {};
  const protocols = input.protocols || {};
  return {
    inputs: {
      vps: {
        host: vps.host === undefined ? undefined : assertHost(vps.host, 'VPS host'),
        port: assertPort(vps.port || 22, 'VPS port'),
        username: vps.username || 'root',
        auth: vps.auth || (vps.privateKey ? 'key' : 'password'),
        password: vps.password,
        privateKey: vps.privateKey,
        passphrase: vps.passphrase,
      },
      router: {
        host: router.host === undefined ? undefined : assertHost(router.host, 'Router host'),
        port: assertPort(router.port || 22, 'Router port'),
        username: router.username || 'root',
        password: router.password,
      },
      protocols: {
        awg: true,
        naive: protocols.naive !== false,
      },
      naiveDomain: input.naiveDomain === undefined ? undefined : assertDomain(input.naiveDomain, 'Домен NaiveProxy'),
    },
    sessions: { vps: null, router: null },
    results: {},
    backup: {},
  };
}

module.exports = { createInstallContext };
