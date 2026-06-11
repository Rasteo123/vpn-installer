#!/usr/bin/env node
// Read-only snapshot of the reference VPS + router into ./reference/,
// with secrets and device-identifying values replaced by stable tokens.
// Credentials come from env vars ONLY (never hardcode device data):
//   VPS_HOST, VPS_PORT?, VPS_USER?(=root), VPS_KEY (path) | VPS_PASS
//   ROUTER_HOST, ROUTER_PORT?, ROUTER_USER?(=root), ROUTER_PASS
const fs = require('fs');
const path = require('path');
const SSHSession = require('../src/main/ssh/SSHSession');
const { redactValues, redactFields } = require('../src/main/snapshot/redact');
const { buildValueMap } = require('../src/main/snapshot/detect');
const { VPS_CAPTURES, ROUTER_CAPTURES } = require('../src/main/snapshot/manifest');
const { assertHost, assertPort } = require('../src/main/config/validate');

const REFERENCE_DIR = path.join(__dirname, '..', 'reference');

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function vpsConfigFromEnv() {
  const cfg = {
    host: assertHost(required('VPS_HOST'), 'VPS_HOST'),
    port: assertPort(process.env.VPS_PORT || 22, 'VPS_PORT'),
    username: process.env.VPS_USER || 'root',
  };
  if (process.env.VPS_KEY) cfg.privateKey = fs.readFileSync(process.env.VPS_KEY, 'utf8');
  else cfg.password = required('VPS_PASS');
  return cfg;
}

function routerConfigFromEnv() {
  return {
    host: assertHost(required('ROUTER_HOST'), 'ROUTER_HOST'),
    port: assertPort(process.env.ROUTER_PORT || 22, 'ROUTER_PORT'),
    username: process.env.ROUTER_USER || 'root',
    password: required('ROUTER_PASS'),
  };
}

async function detectValueMap(vps, router) {
  // Gather device-identifying values from live output (never hardcoded), then
  // let buildValueMap turn them into stable redaction tokens.
  const out = (s) => s.stdout.trim();
  return buildValueMap({
    vpsIp: out(await vps.exec('curl -s -4 ifconfig.me 2>/dev/null || true')) || process.env.VPS_HOST,
    wanIp: out(await router.exec('uci -q get network.wan.ipaddr || true')),
    lanIp: out(await router.exec('uci -q get network.lan.ipaddr || true')),
    naiveJson: (await router.exec('cat /etc/sing-box/naive-client.json 2>/dev/null || true')).stdout,
    defaultRoute: out(await router.exec('ip route show default 2>/dev/null || true')),
    wanDns: out(await router.exec('uci -q get network.wan.dns 2>/dev/null || true')),
  });
}

async function capture(session, captures, target, valueMap) {
  for (const entry of captures) {
    const res = await session.exec(entry.cmd);
    const redacted = redactFields(redactValues(res.stdout, valueMap));
    const dest = path.join(REFERENCE_DIR, target, entry.out);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, redacted);
    console.log(`  ${target}/${entry.out}  (${redacted.length} bytes)`);
  }
}

async function main() {
  const vps = new SSHSession();
  const router = new SSHSession();
  try {
    console.log('Connecting to VPS...');
    await vps.connect(vpsConfigFromEnv());
    console.log('Connecting to router...');
    await router.connect(routerConfigFromEnv());

    console.log('Detecting device values to redact...');
    const valueMap = await detectValueMap(vps, router);
    console.log('  redacting:', Object.values(valueMap).join(', ') || '(none detected)');

    console.log('Capturing VPS...');
    await capture(vps, VPS_CAPTURES, 'vps', valueMap);
    console.log('Capturing router...');
    await capture(router, ROUTER_CAPTURES, 'router', valueMap);

    console.log('Snapshot written to ./reference');
  } finally {
    vps.disconnect();
    router.disconnect();
  }
}

main().catch((err) => {
  console.error('Snapshot failed:', err.message);
  process.exit(1);
});
