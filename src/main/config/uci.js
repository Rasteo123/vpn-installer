function uciBatch(lines) {
  return lines.join('\n') + '\n';
}

// Emits uci commands reproducing reference/router/uci/network awg0 section:
// the amneziawg interface, the server peer, the critical endpoint-bypass route
// (reach the VPS via the WAN gateway, not the tunnel), and the split-default routes.
function awgNetworkUci({
  clientPrivateKey,
  clientAddress = '10.66.66.2/32',
  mtu = 1280,
  obfuscation,
  serverPublicKey,
  presharedKey,
  vpsIp,
  endpointPort = 443,
  wanGw,
}) {
  const o = obfuscation;
  return [
    'delete network.awg0',
    'set network.awg0=interface',
    "set network.awg0.proto='amneziawg'",
    `set network.awg0.private_key='${clientPrivateKey}'`,
    `add_list network.awg0.addresses='${clientAddress}'`,
    `set network.awg0.mtu='${mtu}'`,
    "set network.awg0.defaultroute='1'",
    `set network.awg0.awg_jc='${o.jc}'`,
    `set network.awg0.awg_jmin='${o.jmin}'`,
    `set network.awg0.awg_jmax='${o.jmax}'`,
    `set network.awg0.awg_s1='${o.s1}'`,
    `set network.awg0.awg_s2='${o.s2}'`,
    `set network.awg0.awg_s3='${o.s3}'`,
    `set network.awg0.awg_s4='${o.s4}'`,
    `set network.awg0.awg_h1='${o.h1}'`,
    `set network.awg0.awg_h2='${o.h2}'`,
    `set network.awg0.awg_h3='${o.h3}'`,
    `set network.awg0.awg_h4='${o.h4}'`,
    `set network.awg0.awg_i1='${o.i1}'`,
    'add network amneziawg_awg0',
    "set network.@amneziawg_awg0[-1].description='awg-server'",
    `set network.@amneziawg_awg0[-1].public_key='${serverPublicKey}'`,
    `set network.@amneziawg_awg0[-1].preshared_key='${presharedKey}'`,
    `set network.@amneziawg_awg0[-1].endpoint_host='${vpsIp}'`,
    `set network.@amneziawg_awg0[-1].endpoint_port='${endpointPort}'`,
    "add_list network.@amneziawg_awg0[-1].allowed_ips='0.0.0.0/0'",
    "set network.@amneziawg_awg0[-1].persistent_keepalive='25'",
    "set network.@amneziawg_awg0[-1].route_allowed_ips='0'",
    'add network route',
    "set network.@route[-1].interface='wan'",
    `set network.@route[-1].target='${vpsIp}'`,
    "set network.@route[-1].netmask='255.255.255.255'",
    `set network.@route[-1].gateway='${wanGw}'`,
    'add network route',
    "set network.@route[-1].interface='awg0'",
    "set network.@route[-1].target='0.0.0.0'",
    "set network.@route[-1].netmask='128.0.0.0'",
    'add network route',
    "set network.@route[-1].interface='awg0'",
    "set network.@route[-1].target='128.0.0.0'",
    "set network.@route[-1].netmask='128.0.0.0'",
  ];
}

module.exports = { uciBatch, awgNetworkUci };
