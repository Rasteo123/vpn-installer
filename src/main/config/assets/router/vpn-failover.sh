#!/bin/sh
# Health-check awg0 and tun-naive, then swap main split-default routes.
# Does not touch UCI/PBR/dnsmasq and never edits /etc/config at runtime.

. /etc/vpn-failover.conf

log() { logger -t vpn-failover "$@"; }

probe() {
    iface="$1"

    ip link show "$iface" >/dev/null 2>&1 || return 1
    ip route replace "$HEALTH_IP" dev "$iface" >/dev/null 2>&1 || return 1

    code=$(curl --silent --interface "$iface" --max-time "$PROBE_TIMEOUT" \
        -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)
    rc=$?

    ip route del "$HEALTH_IP" dev "$iface" >/dev/null 2>&1 || true

    [ "$rc" = "0" ] && echo "$code" | grep -qE '^[23]'
}

apply_route() {
    target="$1"

    case "$target" in
        awg)
            iface="$AWG_IFACE"
            state="awg"
            ;;
        naive)
            iface="$NAIVE_IFACE"
            state="naive"
            ;;
        wan)
            # Fail open: stale split-default routes would black-hole all
            # internet traffic when both tunnels are unavailable.
            ip route del "$SPLIT_ROUTE_A" >/dev/null 2>&1 || true
            ip route del "$SPLIT_ROUTE_B" >/dev/null 2>&1 || true
            echo "wan" > "$STATE_FILE"
            log "both VPNs unavailable; removed split routes and fell back to WAN"
            return 0
            ;;
        *)
            log "refusing unknown target=$target"
            return 1
            ;;
    esac

    if ! ip link show "$iface" >/dev/null 2>&1; then
        log "refusing route apply: iface $iface is missing"
        return 1
    fi

    if ip route replace "$SPLIT_ROUTE_A" dev "$iface" proto static scope link \
        && ip route replace "$SPLIT_ROUTE_B" dev "$iface" proto static scope link; then
        echo "$state" > "$STATE_FILE"
        log "applied main split routes: $state ($iface)"
        return 0
    fi

    log "failed to apply main split routes: $state ($iface)"
    return 1
}

choose_once() {
    if probe "$AWG_IFACE"; then
        apply_route awg
    elif probe "$NAIVE_IFACE"; then
        apply_route naive
    else
        apply_route wan
    fi
}

if [ "${1:-}" = "once" ]; then
    choose_once
    exit 0
fi

awg_fails=0; awg_oks=0
naive_fails=0; naive_oks=0
active=""

# Never restore a stale route just because it was active before a reboot or
# provider outage. Probe first, then derive hysteresis state from that result.
choose_once
[ -f "$STATE_FILE" ] && active=$(cat "$STATE_FILE")
case "$active" in
    awg) awg_alive=1; naive_alive=0 ;;
    naive) awg_alive=0; naive_alive=1 ;;
    *) awg_alive=0; naive_alive=0; active="wan" ;;
esac

while :; do
    if probe "$AWG_IFACE"; then
        awg_oks=$((awg_oks + 1)); awg_fails=0
        if [ "$awg_alive" = "0" ] && [ "$awg_oks" -ge "$SUCCESS_THRESHOLD" ]; then
            awg_alive=1; log "awg marked alive"
        fi
    else
        awg_fails=$((awg_fails + 1)); awg_oks=0
        if [ "$awg_alive" = "1" ] && [ "$awg_fails" -ge "$FAIL_THRESHOLD" ]; then
            awg_alive=0; log "awg marked dead"
        fi
    fi

    if probe "$NAIVE_IFACE"; then
        naive_oks=$((naive_oks + 1)); naive_fails=0
        if [ "$naive_alive" = "0" ] && [ "$naive_oks" -ge "$SUCCESS_THRESHOLD" ]; then
            naive_alive=1; log "tun-naive marked alive"
        fi
    else
        naive_fails=$((naive_fails + 1)); naive_oks=0
        if [ "$naive_alive" = "1" ] && [ "$naive_fails" -ge "$FAIL_THRESHOLD" ]; then
            naive_alive=0; log "tun-naive marked dead"
        fi
    fi

    if [ "$awg_alive" = "1" ]; then
        want=awg
    elif [ "$naive_alive" = "1" ]; then
        want=naive
    else
        want=wan
    fi

    if [ -n "$want" ] && [ "$want" != "$active" ]; then
        if apply_route "$want"; then
            active="$want"
        fi
    fi

    sleep "$CHECK_INTERVAL"
done
