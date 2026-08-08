// Pure server-side config templates. Device-specific values are inputs.

// AmneziaWG server config. Defaults match the proven reference scheme;
// secrets/obfuscation/wan iface are inputs. Reproduces reference awg0.conf.
function awgServerConf({
  serverAddress = '10.66.66.1/24',
  listenPort = 443,
  privateKey,
  // 1500 minus WG-over-IPv4 overhead. 1280 fragmented 1300-byte UDP (Steam
  // relay pings); Valve relays ignore fragments, breaking P2P rendezvous.
  mtu = 1420,
  obfuscation,
  wanIface,
  peerPublicKey,
  presharedKey,
  peerAllowedIps = '10.66.66.2/32',
}) {
  const o = obfuscation;
  return `[Interface]
Address = ${serverAddress}
ListenPort = ${listenPort}
PrivateKey = ${privateKey}
MTU = ${mtu}

# AWG 2.0 obfuscation (matching working config pattern)
Jc = ${o.jc}
Jmin = ${o.jmin}
Jmax = ${o.jmax}
S1 = ${o.s1}
S2 = ${o.s2}
S3 = ${o.s3}
S4 = ${o.s4}
H1 = ${o.h1}
H2 = ${o.h2}
H3 = ${o.h3}
H4 = ${o.h4}
I1 = ${o.i1}

PostUp = iptables -I INPUT -p udp --dport ${listenPort} -j ACCEPT
PostUp = iptables -I FORWARD -i ${wanIface} -o awg0 -j ACCEPT
PostUp = iptables -I FORWARD -i awg0 -j ACCEPT
PostUp = iptables -t nat -A POSTROUTING -o ${wanIface} -j MASQUERADE
PostDown = iptables -D INPUT -p udp --dport ${listenPort} -j ACCEPT
PostDown = iptables -D FORWARD -i ${wanIface} -o awg0 -j ACCEPT
PostDown = iptables -D FORWARD -i awg0 -j ACCEPT
PostDown = iptables -t nat -D POSTROUTING -o ${wanIface} -j MASQUERADE

[Peer]
PublicKey = ${peerPublicKey}
PresharedKey = ${presharedKey}
AllowedIPs = ${peerAllowedIps}
`;
}

// AmneziaWG systemd service override (loads the kernel module before start).
function awgOverride() {
  return `[Unit]
After=network-online.target
Wants=network-online.target

[Service]
ExecStartPre=modprobe amneziawg
`;
}

// NaiveProxy (sing-box) server inbound on TCP/443 with the domain's LE cert.
// AWG uses UDP/443, so both services can share the familiar HTTPS port without
// competing for the same socket. Pinning the inbound to TCP keeps Naive on
// HTTP/2 and avoids the easier-to-classify QUIC/non-standard-port fallback.
function naiveServerJson({ username, password, domain, listenPort = 443 }) {
  return `{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "naive",
      "tag": "naive-in",
      "listen": "0.0.0.0",
      "listen_port": ${listenPort},
      "network": "tcp",
      "users": [
        { "username": "${username}", "password": "${password}" }
      ],
      "tls": {
        "enabled": true,
        "server_name": "${domain}",
        "certificate_path": "/etc/letsencrypt/live/${domain}/fullchain.pem",
        "key_path": "/etc/letsencrypt/live/${domain}/privkey.pem"
      }
    }
  ],
  "outbounds": [
    { "type": "direct", "tag": "direct" }
  ]
}
`;
}

// systemd unit for the sing-box naive server.
function singBoxNaiveService() {
  return `[Unit]
Description=sing-box (naive fallback) on TCP/443
After=network-online.target nss-lookup.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/bin/sing-box run -c /etc/sing-box/naive.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`;
}

// nginx only owns TCP/80 for ACME renewal. TCP/443 belongs to NaiveProxy;
// ordinary HTTP requests are redirected to a public HTTPS site.
function nginxServerConf({ domain, camouflageHost = 'www.microsoft.com' }) {
  return `user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 2048;
}

http {
    server {
        listen 80;
        server_name ${domain};
        location /.well-known/acme-challenge/ {
            root /var/www/html;
        }
        location / {
            return 302 https://${camouflageHost}$request_uri;
        }
    }
}
`;
}

module.exports = {
  awgServerConf,
  awgOverride,
  naiveServerJson,
  singBoxNaiveService,
  nginxServerConf,
};
