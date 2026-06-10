// Single shared state object for an install run. Device-specific values come
// only from `inputs`; `results` is filled by steps and returned to the UI.
function createInstallContext(input = {}) {
  const vps = input.vps || {};
  const router = input.router || {};
  const protocols = input.protocols || {};
  return {
    inputs: {
      vps: {
        host: vps.host,
        port: vps.port || 22,
        username: vps.username || 'root',
        auth: vps.auth || (vps.privateKey ? 'key' : 'password'),
        password: vps.password,
        privateKey: vps.privateKey,
        passphrase: vps.passphrase,
      },
      router: {
        host: router.host,
        port: router.port || 22,
        username: router.username || 'root',
        password: router.password,
      },
      protocols: {
        awg: true,
        naive: protocols.naive !== false,
      },
      naiveDomain: input.naiveDomain,
    },
    sessions: { vps: null, router: null },
    results: {},
    backup: {},
  };
}

module.exports = { createInstallContext };
