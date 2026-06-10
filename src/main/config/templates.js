// Pure server-side config templates. Device-specific values are inputs.

// AmneziaWG server config. Defaults match the proven reference scheme;
// secrets/obfuscation/wan iface are inputs. Reproduces reference awg0.conf.
function awgServerConf({
  serverAddress = '10.66.66.1/24',
  listenPort = 443,
  privateKey,
  mtu = 1280,
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

// NaiveProxy (sing-box) server inbound on :2053 with the domain's LE cert.
function naiveServerJson({ username, password, domain, listenPort = 2053 }) {
  return `{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "naive",
      "tag": "naive-in",
      "listen": "0.0.0.0",
      "listen_port": ${listenPort},
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
Description=sing-box (naive fallback) on :2053
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

// nginx: ACME (:80) + camouflage HTTPS (:443) for the domain.
// Simplified vs the VLESS-era reference (no SNI stream multiplexer).
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
            return 301 https://$host$request_uri;
        }
    }

    server {
        listen 443 ssl;
        server_name ${domain};

        ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

        # Camouflage: look like a real site
        location / {
            proxy_pass https://${camouflageHost};
            proxy_set_header Host ${camouflageHost};
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_ssl_server_name on;
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
