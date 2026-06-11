#!/usr/bin/env node
// Live server installer (Plan 5). Connects to the VPS and runs the server steps.
// Env: VPS_HOST, VPS_KEY (path) | VPS_PASS, VPS_USER?(=root), NAIVE_DOMAIN?
const fs = require('fs');
const SSHSession = require('../src/main/ssh/SSHSession');
const { createInstallContext } = require('../src/main/context');
const { Orchestrator } = require('../src/main/orchestrator');
const { serverAwg } = require('../src/main/steps/server-awg');
const { serverNaive } = require('../src/main/steps/server-naive');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main() {
  const vpsInput = { host: required('VPS_HOST'), username: process.env.VPS_USER || 'root' };
  if (process.env.VPS_KEY) { vpsInput.privateKey = fs.readFileSync(process.env.VPS_KEY, 'utf8'); vpsInput.auth = 'key'; }
  else { vpsInput.password = required('VPS_PASS'); vpsInput.auth = 'password'; }

  const ctx = createInstallContext({
    vps: vpsInput,
    naiveDomain: process.env.NAIVE_DOMAIN,
    protocols: { naive: !!process.env.NAIVE_DOMAIN },
  });
  ctx.log = (m) => console.log('   ' + m);
  ctx.inputs.certStaging = !!process.env.NAIVE_STAGING;

  let steps = [serverAwg];
  if (ctx.inputs.protocols.naive) steps.push(serverNaive);
  if (process.env.STEPS) {
    const want = process.env.STEPS.split(',');
    steps = steps.filter((s) => want.includes(s.id.replace('server.', '')));
  }

  const vps = new SSHSession();
  console.log(`Connecting to VPS ${ctx.inputs.vps.host}...`);
  await vps.connect(ctx.inputs.vps);
  ctx.sessions.vps = vps;

  const orch = new Orchestrator((e) => {
    if (e.type === 'step-start') console.log(`▶ ${e.stepId}`);
    if (e.type === 'step-done') console.log(`✔ ${e.stepId}`);
    if (e.type === 'step-fail') console.log(`✘ ${e.stepId} FAILED (${e.phase || 'execute'}): ${e.error}`);
  });

  const res = await orch.run(steps, ctx, { preflightAll: true, rollbackOnFailure: false });
  vps.disconnect();

  console.log('\n--- results ---');
  console.log(JSON.stringify(ctx.results, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main().catch((err) => { console.error('install-server failed:', err.message); process.exit(1); });
