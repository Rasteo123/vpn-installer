const { ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const SSHSession = require('../ssh/SSHSession');
const { createInstallContext } = require('../context');
const { Orchestrator } = require('../orchestrator');
const { restoreRouter } = require('../steps/router-backup');
const { runRouterSteps } = require('../steps/router-run');
const { serverStepsFor, routerStepsFor } = require('../steps/select-steps');
const { detectDeployment } = require('../steps/server-adopt');

const MANUAL_RESTORE_HINT =
  'Manual restore: uci import network < /root/vpn-installer-backup-latest.network && uci commit network && /etc/init.d/network restart (same for firewall, pbr).';

// One context carried across the server and router phases of a session.
let current = null;

const { assertHost, assertPort } = require('../config/validate');

function vpsConnectConfig(vps) {
  const cfg = { host: assertHost(vps.host, 'VPS host'), port: assertPort(vps.port || 22, 'VPS port'), username: vps.username || 'root' };
  if (vps.auth === 'key') {
    cfg.privateKey = vps.keyPath ? fs.readFileSync(vps.keyPath, 'utf8') : vps.privateKey;
    if (vps.passphrase) cfg.passphrase = vps.passphrase;
  } else {
    cfg.password = vps.password;
  }
  return cfg;
}

// Never expose secret keys back to the renderer; keep what the user needs.
function scrub(results) {
  const r = JSON.parse(JSON.stringify(results || {}));
  if (r.awg) { delete r.awg.clientPrivateKey; delete r.awg.presharedKey; }
  return r;
}

function registerHandlers() {
  ipcMain.handle('pick-key-file', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Выберите файл SSH-ключа',
      defaultPath: path.join(os.homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

  ipcMain.handle('connect-vps', async (_e, vps) => {
    const s = new SSHSession();
    try { await s.connect(vpsConnectConfig(vps)); s.disconnect(); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('connect-router', async (_e, router) => {
    const s = new SSHSession();
    try {
      await s.connect({ host: assertHost(router.host, 'Router host'), port: assertPort(router.port || 22, 'Router port'), username: 'root', password: router.password });
      s.disconnect();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('install-server', async (event, config) => {
    let ctx;
    try {
      ctx = createInstallContext({
        vps: { ...config.vps, auth: config.vps.auth },
        naiveDomain: config.naiveDomain,
        protocols: { naive: !!config.naiveDomain },
      });
    } catch (e) { return { ok: false, error: e.message }; }
    ctx.inputs.certStaging = !!config.certStaging;
    ctx.log = (m) => event.sender.send('install-log', { phase: 'server', message: m });

    const vps = new SSHSession();
    try { await vps.connect(vpsConnectConfig(config.vps)); }
    catch (e) { return { ok: false, error: `VPS connect failed: ${e.message}` }; }
    ctx.sessions.vps = vps;
    current = ctx;

    // A stack already deployed by this tool is adopted (new client added),
    // never reinstalled over someone's working setup.
    let detected;
    try { detected = await detectDeployment(vps); }
    catch (e) { vps.disconnect(); return { ok: false, error: `Deployment detection failed: ${e.message}` }; }
    if (detected.awg || detected.naive) {
      ctx.log('Existing installer deployment found — adding a new client to it instead of reinstalling.');
    }
    const steps = serverStepsFor(ctx, detected);
    const orch = new Orchestrator((e) => event.sender.send('install-event', e));
    // preflightAll: catch a misconfigured naive domain (DNS) before the long AWG install.
    const res = await orch.run(steps, ctx, { preflightAll: true, rollbackOnFailure: false });
    vps.disconnect();
    return { ok: res.ok, error: res.error && res.error.message, results: scrub(ctx.results) };
  });

  ipcMain.handle('install-router', async (event, config) => {
    const ctx = current || createInstallContext({});
    try {
      ctx.inputs.router = { host: assertHost(config.router.host, 'Router host'), port: assertPort(config.router.port || 22, 'Router port'), username: 'root', password: config.router.password };
      if (config.vpsHost) ctx.inputs.vps.host = assertHost(config.vpsHost, 'VPS host');
    } catch (e) { return { ok: false, error: e.message }; }
    ctx.log = (m) => event.sender.send('install-log', { phase: 'router', message: m });

    const router = new SSHSession();
    try { await router.connect(ctx.inputs.router); }
    catch (e) { return { ok: false, error: `Router connect failed: ${e.message}` }; }
    ctx.sessions.router = router;

    // router.naive is only planned when the server phase produced naive creds.
    const steps = routerStepsFor(ctx);
    const orch = new Orchestrator((e) => event.sender.send('install-event', e));
    const out = await runRouterSteps(orch, steps, ctx, { restoreRouter });
    if (out.ok === false) {
      if (out.restored) ctx.log('Router restored from backup.');
      else { ctx.log('Restore FAILED: ' + (out.restoreError || 'unknown')); ctx.log(MANUAL_RESTORE_HINT); }
    }
    router.disconnect();
    return {
      ok: out.ok,
      error: out.error && out.error.message,
      restored: out.restored,
      results: scrub(ctx.results),
    };
  });
}

module.exports = { registerHandlers };
