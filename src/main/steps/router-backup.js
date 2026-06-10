const { makeStep } = require('./step');

async function dump(session, pkg) {
  return (await session.exec(`uci export ${pkg} 2>/dev/null`)).stdout;
}

// Snapshots the router's uci config before any change. The captured exports
// drive restoreRouter() — the full-restore safety net.
const routerBackup = makeStep({
  id: 'router.backup',
  title: 'Backup router config',
  target: 'router',
  async execute(ctx) {
    const s = ctx.sessions.router;
    ctx.backup.network = await dump(s, 'network');
    ctx.backup.firewall = await dump(s, 'firewall');
    ctx.backup.pbr = await dump(s, 'pbr');
    for (const pkg of ['network', 'firewall', 'pbr']) {
      await s.writeFile(`/root/vpn-installer-backup-latest.${pkg}`, ctx.backup[pkg] || '');
    }
  },
  async verify(ctx) {
    if (!ctx.backup.network) throw new Error('router.backup: empty network export');
  },
});

// Full-restore safety net — called by the runner on any router failure.
async function restoreRouter(ctx) {
  const s = ctx.sessions.router;
  for (const pkg of ['network', 'firewall', 'pbr']) {
    const body = ctx.backup[pkg];
    if (!body) continue;
    await s.writeFile(`/tmp/restore.${pkg}`, body);
    await s.exec(`uci import ${pkg} < /tmp/restore.${pkg} && uci commit ${pkg}`);
  }
  await s.exec('/etc/init.d/network restart');
  await s.exec('/etc/init.d/firewall restart');
}

module.exports = { routerBackup, restoreRouter };
