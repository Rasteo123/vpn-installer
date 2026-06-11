#!/usr/bin/env node
// Live router installer (Plan 6). SUPERVISED, backup-first, auto-restore on failure.
// Env: ROUTER_HOST, ROUTER_PASS, ROUTER_USER?(=root), VPS_HOST, NAIVE_DOMAIN?,
//      RESULTS (path to JSON with { awg, naive } from the server install).
const fs = require('fs');
const SSHSession = require('../src/main/ssh/SSHSession');
const { createInstallContext } = require('../src/main/context');
const { Orchestrator } = require('../src/main/orchestrator');
const { routerBackup, restoreRouter } = require('../src/main/steps/router-backup');
const { routerAwg } = require('../src/main/steps/router-awg');
const { routerNaive } = require('../src/main/steps/router-naive');
const { routerPbr } = require('../src/main/steps/router-pbr');
const { routerFailover } = require('../src/main/steps/router-failover');
const { routerVerify } = require('../src/main/steps/router-verify');
const { runRouterSteps } = require('../src/main/steps/router-run');

function required(n) { const v = process.env[n]; if (!v) throw new Error(`Missing env ${n}`); return v; }

async function main() {
  const ctx = createInstallContext({
    vps: { host: required('VPS_HOST') },
    router: { host: required('ROUTER_HOST'), password: required('ROUTER_PASS'), username: process.env.ROUTER_USER || 'root' },
    naiveDomain: process.env.NAIVE_DOMAIN,
  });
  const results = JSON.parse(fs.readFileSync(required('RESULTS'), 'utf8'));
  ctx.results.awg = results.awg;
  ctx.results.naive = results.naive;
  ctx.log = (m) => console.log('   ' + m);

  const router = new SSHSession();
  console.log(`Connecting to router ${ctx.inputs.router.host}...`);
  await router.connect(ctx.inputs.router);
  ctx.sessions.router = router;

  const steps = [routerBackup, routerAwg, routerNaive, routerPbr, routerFailover, routerVerify];
  const orch = new Orchestrator((e) => {
    if (e.type === 'step-start') console.log(`▶ ${e.stepId}`);
    if (e.type === 'step-done') console.log(`✔ ${e.stepId}`);
    if (e.type === 'step-fail') console.log(`✘ ${e.stepId} FAILED (${e.phase || 'execute'}): ${e.error}`);
  });

  const out = await runRouterSteps(orch, steps, ctx, { restoreRouter });
  if (out.ok === false) {
    console.log(`\n⚠ Failure: ${out.error && out.error.message}`);
    if (out.restored) console.log('Router restored from backup.');
    else console.log('RESTORE FAILED: ' + out.restoreError + '\nManual: uci import <pkg> < /root/vpn-installer-backup-latest.<pkg> && uci commit <pkg> (network, firewall, pbr); then /etc/init.d/network restart');
  }

  router.disconnect();
  console.log('\n--- results ---');
  console.log(JSON.stringify(ctx.results, null, 2));
  process.exit(out.ok ? 0 : 1);
}

main().catch((e) => { console.error('install-router failed:', e.message); process.exit(1); });
