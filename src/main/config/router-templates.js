const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, 'assets', 'router');
function readAsset(name) {
  return fs.readFileSync(path.join(ASSETS, name), 'utf8');
}

// NaiveProxy client (sing-box): tun inbound + naive outbound to the VPS.
// Reproduces reference router naive-client.json. Device values are inputs.
function naiveClientJson({
  vpsIp,
  naivePort = 2053,
  username,
  password,
  domain,
  tunName = 'tun-naive',
  tunAddress = '172.31.0.2/30',
  mtu = 1380,
}) {
  return `{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "tun",
      "tag": "${tunName}",
      "interface_name": "${tunName}",
      "address": [ "${tunAddress}" ],
      "auto_route": false,
      "strict_route": false,
      "stack": "gvisor",
      "mtu": ${mtu}
    }
  ],
  "outbounds": [
    {
      "type": "naive",
      "tag": "naive-out",
      "server": "${vpsIp}",
      "server_port": ${naivePort},
      "username": "${username}",
      "password": "${password}",
      "tls": {
        "enabled": true,
        "server_name": "${domain}"
      }
    },
    {
      "type": "direct",
      "tag": "direct-out"
    },
    {
      "type": "block",
      "tag": "block-out"
    }
  ],
  "route": {
    "rules": [
      { "ip_cidr": [ "${vpsIp}/32" ], "outbound": "direct-out" }
    ],
    "final": "naive-out"
  }
}
`;
}

// RU-CIDR updater: pulls RU ranges from RIPE into the PBR nftset. The nftset
// name is supplied at runtime from the created policy — never hardcoded.
function updateRuCidrScript({ nftset }) {
  return `#!/bin/sh
# Download Russian CIDR list from RIPE and load into PBR nftset
NFTSET="${nftset}"
RAWFILE="/etc/awg-bypass/ru_cidr.raw"
NFTFILE="/etc/awg-bypass/ru_cidr_load.nft"
TMPFILE="/tmp/ru_cidr_new.raw"

# Download
if curl -sS --max-time 60 "https://stat.ripe.net/data/country-resource-list/data.json?resource=ru" \\
    | jq -r ".data.resources.ipv4[]" > "$TMPFILE" 2>/dev/null; then
    COUNT=$(wc -l < "$TMPFILE")
    if [ "$COUNT" -lt 1000 ]; then
        logger -t ru-cidr "ERROR: list too small ($COUNT), keeping old"
        rm -f "$TMPFILE"
        exit 1
    fi
    mv "$TMPFILE" "$RAWFILE"
    logger -t ru-cidr "Downloaded $COUNT entries"
else
    logger -t ru-cidr "Download failed, keeping old"
    rm -f "$TMPFILE"
    [ -f "$RAWFILE" ] || exit 1
fi

# Build nft file
{
    echo "add element inet fw4 \${NFTSET} {"
    sed "s/$/,/" "$RAWFILE" | sed "$ s/,$//"
    echo "}"
} > "$NFTFILE"

# Load if nftset exists
if nft list set inet fw4 "$NFTSET" >/dev/null 2>&1; then
    nft -f "$NFTFILE" 2>/dev/null
    logger -t ru-cidr "Loaded into nftset"
fi
`;
}

// Static files — deployed verbatim from canonical assets (no per-install values).
function vpnFailoverConf() { return readAsset('vpn-failover.conf'); }
function vpnFailoverScript() { return readAsset('vpn-failover.sh'); }
function vpnFailoverInitd() { return readAsset('vpn-failover.initd'); }
function singBoxNaiveInitd() { return readAsset('sing-box-naive.initd'); }

module.exports = {
  naiveClientJson,
  updateRuCidrScript,
  vpnFailoverConf,
  vpnFailoverScript,
  vpnFailoverInitd,
  singBoxNaiveInitd,
};
