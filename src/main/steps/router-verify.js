const { makeStep } = require('./step');

// End-to-end check: traffic through the tunnel must egress via the VPS.
const routerVerify = makeStep({
  id: 'router.verify',
  title: 'End-to-end verify (router)',
  target: 'router',

  async execute() { /* all checks are read-only, in verify */ },

  async verify(ctx) {
    const s = ctx.sessions.router;
    const vpsIp = ctx.inputs.vps.host;
    const out = (await s.exec('curl -s --interface awg0 --max-time 12 https://api.ipify.org 2>/dev/null')).stdout.trim();
    if (out !== vpsIp) {
      throw new Error(`router.verify: egress IP via awg0 is '${out || '(none)'}', expected VPS ${vpsIp}`);
    }
  },
});

module.exports = { routerVerify };
