// Build the value->token map used to scrub a snapshot. Everything that could
// identify the specific VPS / home line is detected from live output (never
// hardcoded) and replaced with a stable placeholder.
function buildValueMap({ vpsIp, wanIp, lanIp, naiveJson, defaultRoute, wanDns } = {}) {
  const map = {};
  const put = (value, token) => { if (value) map[value] = token; };

  put(vpsIp, '__VPS_IP__');
  put(wanIp, '__ROUTER_WAN_IP__');
  put(lanIp, '__ROUTER_LAN_IP__');

  if (naiveJson) {
    const domain = /"server_name"\s*:\s*"([^"]+)"/.exec(naiveJson);
    if (domain) put(domain[1], '__DOMAIN__');
    const user = /"username"\s*:\s*"([^"]+)"/.exec(naiveJson);
    if (user) put(user[1], '__NAIVE_USER__');
  }

  if (defaultRoute) {
    const gw = /default\s+via\s+(\S+)/.exec(defaultRoute);
    if (gw) put(gw[1], '__ROUTER_WAN_GW__');
  }

  for (const ip of String(wanDns || '').split(/\s+/).filter(Boolean)) {
    put(ip, '__ROUTER_DNS__');
  }

  return map;
}

module.exports = { buildValueMap };
