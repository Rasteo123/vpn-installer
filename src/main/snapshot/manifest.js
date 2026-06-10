// Read-only capture plan. Each entry runs `cmd` on the target and stores the
// (redacted) output at reference/<target>/<out>. `|| true` guards optional files.
const VPS_CAPTURES = [
  { cmd: 'cat /etc/os-release', out: 'os-release' },
  { cmd: 'cat /etc/amnezia/amneziawg/awg0.conf', out: 'etc/amnezia/amneziawg/awg0.conf' },
  { cmd: 'cat /etc/sing-box/naive.json', out: 'etc/sing-box/naive.json' },
  { cmd: 'cat /etc/nginx/nginx.conf', out: 'etc/nginx/nginx.conf' },
  { cmd: 'cat /etc/systemd/system/awg-quick@awg0.service.d/override.conf 2>/dev/null || true', out: 'etc/systemd/awg-override.conf' },
  { cmd: 'cat /etc/systemd/system/sing-box-naive.service', out: 'etc/systemd/sing-box-naive.service' },
  { cmd: 'ufw status verbose 2>/dev/null || true', out: 'ufw-status.txt' },
  { cmd: 'iptables -S 2>/dev/null || true', out: 'iptables-filter.txt' },
  { cmd: 'iptables -t nat -S 2>/dev/null || true', out: 'iptables-nat.txt' },
  { cmd: 'ss -tulpn 2>/dev/null || true', out: 'listening-ports.txt' },
];

const ROUTER_CAPTURES = [
  { cmd: 'ubus call system board', out: 'board.json' },
  { cmd: 'uci export network', out: 'uci/network' },
  { cmd: 'uci export firewall', out: 'uci/firewall' },
  { cmd: 'uci export pbr 2>/dev/null || true', out: 'uci/pbr' },
  { cmd: 'cat /etc/sing-box/naive-client.json', out: 'etc/sing-box/naive-client.json' },
  { cmd: 'cat /etc/init.d/sing-box-naive', out: 'etc/init.d/sing-box-naive' },
  { cmd: 'cat /etc/vpn-failover.conf', out: 'etc/vpn-failover.conf' },
  { cmd: 'cat /usr/bin/vpn-failover.sh', out: 'usr/bin/vpn-failover.sh' },
  { cmd: 'cat /etc/init.d/vpn-failover', out: 'etc/init.d/vpn-failover' },
  { cmd: 'crontab -l 2>/dev/null || true', out: 'crontab.txt' },
  { cmd: 'cat /etc/awg-bypass/update-ru-cidr.sh 2>/dev/null || true', out: 'etc/awg-bypass/update-ru-cidr.sh' },
  { cmd: 'opkg list-installed 2>/dev/null | grep -iE "amneziawg|sing-box|pbr|kmod-tun" || true', out: 'packages.txt' },
  { cmd: 'ip -br addr 2>/dev/null || true', out: 'ip-addr.txt' },
  { cmd: 'ip route show 2>/dev/null || true', out: 'ip-route.txt' },
];

module.exports = { VPS_CAPTURES, ROUTER_CAPTURES };
