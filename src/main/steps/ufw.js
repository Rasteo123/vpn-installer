// Helpers for cooperating with ufw on the VPS. The reference VPS runs ufw with
// `deny incoming`, so any service we install must have its port opened or it
// will be silently unreachable. We touch ufw only when it is actually active.

async function ufwActive(session) {
  const r = await session.exec('ufw status 2>/dev/null || true');
  return /Status:\s*active/i.test(r.stdout);
}

// Open the given ports (e.g. '443/udp', '2053/tcp') only if ufw is active.
// Returns the list actually added so a rollback can undo exactly those.
async function openUfwPorts(session, ports) {
  if (!(await ufwActive(session))) return [];
  for (const p of ports) {
    await session.exec(`ufw allow ${p}`);
  }
  return ports;
}

async function closeUfwPorts(session, ports) {
  for (const p of ports) {
    await session.exec(`ufw delete allow ${p} 2>/dev/null || true`);
  }
}

module.exports = { ufwActive, openUfwPorts, closeUfwPorts };
