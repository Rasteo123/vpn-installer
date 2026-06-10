const { ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const SSHSession = require('../ssh/SSHSession');
const { createInstallContext } = require('../context');
const { Orchestrator } = require('../orchestrator');
const { serverAwg } = require('../steps/server-awg');
const { serverNaive } = require('../steps/server-naive');
const { routerBackup, restoreRouter } = require('../steps/router-backup');
const { routerAwg } = require('../steps/router-awg');
const { routerNaive } = require('../steps/router-naive');
const { routerPbr } = require('../steps/router-pbr');
const { routerFailover } = require('../steps/router-failover');
const { routerVerify } = require('../steps/router-verify');

// One context carried across the server and router phases of a session.
let current = null;

function vpsConnectConfig(vps) {
  const cfg = { host: vps.host, port: Number(vps.port) || 22, username: vps.username || 'root' };
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
      await s.connect({ host: router.host, port: Number(router.port) || 22, username: 'root', password: router.password });
      s.disconnect();
      return { ok: true };
    } catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('install-server', async (event, config) => {
    const ctx = createInstallContext({
      vps: { ...config.vps, auth: config.vps.auth },
      naiveDomain: config.naiveDomain,
      protocols: { naive: !!config.naiveDomain },
    });
    ctx.inputs.certStaging = !!config.certStaging;
    ctx.log = (m) => event.sender.send('install-log', { phase: 'server', message: m });

    const vps = new SSHSession();
    try { await vps.connect(vpsConnectConfig(config.vps)); }
    catch (e) { return { ok: false, error: `VPS connect failed: ${e.message}` }; }
    ctx.sessions.vps = vps;
    current = ctx;

    const steps = [serverAwg];
    if (ctx.inputs.protocols.naive) steps.push(serverNaive);
    const orch = new Orchestrator((e) => event.sender.send('install-event', e));
    const res = await orch.run(steps, ctx, { rollbackOnFailure: false });
    vps.disconnect();
    return { ok: res.ok, error: res.error && res.error.message, results: scrub(ctx.results) };
  });

  ipcMain.handle('install-router', async (event, config) => {
    const ctx = current || createInstallContext({});
    ctx.inputs.router = { host: config.router.host, port: Number(config.router.port) || 22, username: 'root', password: config.router.password };
    if (config.vpsHost) ctx.inputs.vps.host = config.vpsHost;
    ctx.log = (m) => event.sender.send('install-log', { phase: 'router', message: m });

    const router = new SSHSession();
    try { await router.connect(ctx.inputs.router); }
    catch (e) { return { ok: false, error: `Router connect failed: ${e.message}` }; }
    ctx.sessions.router = router;

    const steps = [routerBackup, routerAwg, routerNaive, routerPbr, routerFailover, routerVerify];
    const orch = new Orchestrator((e) => event.sender.send('install-event', e));
    const res = await orch.run(steps, ctx, { preflightAll: true, rollbackOnFailure: true });
    if (!res.ok) {
      try { await restoreRouter(ctx); ctx.log('Router restored from backup.'); }
      catch (e) { ctx.log('Restore FAILED: ' + e.message); }
    }
    router.disconnect();
    return { ok: res.ok, error: res.error && res.error.message, results: scrub(ctx.results) };
  });
}

module.exports = { registerHandlers };
