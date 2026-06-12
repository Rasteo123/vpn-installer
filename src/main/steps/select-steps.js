const { serverAwg } = require('./server-awg');
const { serverNaive } = require('./server-naive');
const { adoptServerAwg, adoptServerNaive } = require('./server-adopt');
const { routerBackup } = require('./router-backup');
const { routerAwg } = require('./router-awg');
const { routerNaive } = require('./router-naive');
const { routerPbr } = require('./router-pbr');
const { routerFailover } = require('./router-failover');
const { routerVerify } = require('./router-verify');

// The single place that decides WHICH steps a phase runs. Both the Electron
// IPC handlers and the CLI runners assemble their step lists here.

// `detected` comes from detectDeployment(): components already installed on
// the VPS by this tool are adopted (new client added) instead of reinstalled.
// An existing naive is adopted even if the user didn't enable naive — it is
// read-only and gives the router its fallback for free.
function serverStepsFor(ctx, detected = {}) {
  const steps = [detected.awg ? adoptServerAwg : serverAwg];
  if (detected.naive) steps.push(adoptServerNaive);
  else if (ctx.inputs.protocols.naive) steps.push(serverNaive);
  return steps;
}

// router.naive needs the server-side naive credentials; when the server phase
// produced none (no domain / naive disabled), the step is not planned at all —
// otherwise its preflight would fail the whole router phase.
function routerStepsFor(ctx) {
  const steps = [routerBackup, routerAwg];
  if (ctx.results.naive) steps.push(routerNaive);
  steps.push(routerPbr, routerFailover, routerVerify);
  return steps;
}

module.exports = { serverStepsFor, routerStepsFor };
