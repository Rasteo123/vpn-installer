#!/bin/sh

config_file=${VPN_FAILOVER_CONFIG:-/etc/vpn-failover.conf}
core_file=${VPN_FAILOVER_CORE:-/usr/lib/vpn-failover/core.sh}
initd_dir=${VPN_FAILOVER_INITD_DIR:-/etc/init.d}
probe_driver=${VPN_FAILOVER_PROBE_DRIVER:-}
event_log=${VPN_FAILOVER_EVENT_LOG:-}
max_cycles=${VPN_FAILOVER_MAX_CYCLES:-0}
no_sleep=${VPN_FAILOVER_NO_SLEEP:-0}

[ -r "$config_file" ] || {
    logger -t vpn-failover "missing config: $config_file"
    exit 1
}
[ -r "$core_file" ] || {
    logger -t vpn-failover "missing core library: $core_file"
    exit 1
}

. "$config_file"
. "$core_file"

awg_fails=0
awg_oks=0
awg_alive=0
awg_last_ifup=0
naive_fails=0
naive_oks=0
naive_alive=0
olcrtc_fails=0
olcrtc_oks=0
olcrtc_alive=0
olcrtc_started=0
active=
last_change=0
early_check=0
probe_route=

log() {
    logger -t vpn-failover "$*"
}

event() {
    [ -n "$event_log" ] && printf '%s\n' "$1" >> "$event_log"
    log "$1"
}

write_state() {
    state_tmp="${STATE_FILE}.$$"
    printf '%s\n' "$1" > "$state_tmp" || return 1
    mv "$state_tmp" "$STATE_FILE"
}

remove_probe_route() {
    [ -n "$probe_route" ] || return 0
    ip route del "$probe_route/32" >/dev/null 2>&1 || true
    probe_route=
}

cleanup() {
    remove_probe_route
    rm -f "$PID_FILE"
}

trap cleanup 0
trap 'exit 0' INT TERM
trap 'early_check=1' USR1

service_action() {
    service_name=$1
    service_operation=$2
    "$initd_dir/$service_name" "$service_operation"
}

wait_for_socks() {
    wait_elapsed=0
    while [ "$wait_elapsed" -lt "$OLCRTC_START_TIMEOUT" ]; do
        if netstat -lnt 2>/dev/null | grep -q "127.0.0.1:${OLCRTC_SOCKS_PORT}"; then
            return 0
        fi
        sleep 1
        wait_elapsed=$((wait_elapsed + 1))
    done
    return 1
}

wait_for_iface() {
    wait_iface=$1
    wait_limit=${2:-$OLCRTC_START_TIMEOUT}
    wait_elapsed=0
    while [ "$wait_elapsed" -lt "$wait_limit" ]; do
        if ip link show "$wait_iface" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        wait_elapsed=$((wait_elapsed + 1))
    done
    return 1
}

start_olcrtc_stack() {
    [ "$olcrtc_started" = 0 ] || return 0

    if ! service_action olcrtc-client start; then
        log 'failed to start olcrtc-client'
        return 1
    fi
    event 'service:start:olcrtc-client'

    if ! wait_for_socks; then
        log 'olcrtc SOCKS listener timed out'
        service_action olcrtc-client stop >/dev/null 2>&1 || true
        event 'service:stop:olcrtc-client'
        return 1
    fi

    if ! service_action sing-box-olcrtc start; then
        log 'failed to start sing-box-olcrtc'
        service_action olcrtc-client stop >/dev/null 2>&1 || true
        event 'service:stop:olcrtc-client'
        return 1
    fi
    event 'service:start:sing-box-olcrtc'

    if ! wait_for_iface "$OLCRTC_IFACE"; then
        log 'tun-olcrtc interface timed out'
        service_action sing-box-olcrtc stop >/dev/null 2>&1 || true
        event 'service:stop:sing-box-olcrtc'
        service_action olcrtc-client stop >/dev/null 2>&1 || true
        event 'service:stop:olcrtc-client'
        return 1
    fi

    olcrtc_started=1
    return 0
}

stop_olcrtc_stack() {
    [ "$olcrtc_started" = 1 ] || return 0
    service_action sing-box-olcrtc stop >/dev/null 2>&1 || true
    event 'service:stop:sing-box-olcrtc'
    service_action olcrtc-client stop >/dev/null 2>&1 || true
    event 'service:stop:olcrtc-client'
    olcrtc_started=0
    olcrtc_alive=0
    olcrtc_fails=0
    olcrtc_oks=0
}

probe_target() {
    probe_iface=$1
    probe_target_ip=$2

    probe_route=$probe_target_ip
    if ! ip route replace "$probe_target_ip/32" dev "$probe_iface" proto static scope link >/dev/null 2>&1; then
        probe_route=
        return 1
    fi

    if [ -n "$probe_driver" ]; then
        "$probe_driver" "$probe_iface" "$probe_target_ip"
        probe_rc=$?
    else
        curl --silent --insecure --interface "$probe_iface" \
            --connect-timeout "$PROBE_TIMEOUT" --max-time "$PROBE_TIMEOUT" \
            --output /dev/null "https://$probe_target_ip/"
        probe_rc=$?
    fi

    remove_probe_route
    return "$probe_rc"
}

probe_iface() {
    probe_iface_name=$1
    ip link show "$probe_iface_name" >/dev/null 2>&1 || return 1
    probe_target "$probe_iface_name" "$PROBE_PRIMARY" && return 0
    probe_target "$probe_iface_name" "$PROBE_SECONDARY"
}

target_rank() {
    case "$1" in
        awg) echo 1 ;;
        naive) echo 2 ;;
        olcrtc) echo 3 ;;
        wan) echo 4 ;;
        *) echo 99 ;;
    esac
}

change_allowed() {
    wanted=$1
    [ -z "$active" ] && return 0
    [ "$(target_rank "$wanted")" -lt "$(target_rank "$active")" ] && return 0
    now=$(date +%s)
    [ $((now - last_change)) -ge "$HOLDDOWN_SECONDS" ]
}

apply_route() {
    route_target=$1

    case "$route_target" in
        wan)
            ip route del "$SPLIT_ROUTE_A" >/dev/null 2>&1 || true
            ip route del "$SPLIT_ROUTE_B" >/dev/null 2>&1 || true
            ;;
        awg) route_iface=$AWG_IFACE ;;
        naive) route_iface=$NAIVE_IFACE ;;
        olcrtc) route_iface=$OLCRTC_IFACE ;;
        *)
            log "refusing unknown target=$route_target"
            return 1
            ;;
    esac

    if [ "$route_target" != wan ]; then
        ip link show "$route_iface" >/dev/null 2>&1 || return 1
        if ! ip route replace "$SPLIT_ROUTE_A" dev "$route_iface" proto static scope link; then
            return 1
        fi
        if ! ip route replace "$SPLIT_ROUTE_B" dev "$route_iface" proto static scope link; then
            ip route del "$SPLIT_ROUTE_A" >/dev/null 2>&1 || true
            return 1
        fi
    fi

    write_state "$route_target" || return 1
    active=$route_target
    last_change=$(date +%s)
    event "route:$route_target"
}

restore_state() {
    [ -r "$STATE_FILE" ] || return 0
    restored=$(cat "$STATE_FILE")
    case "$restored" in
        awg)
            awg_alive=1
            apply_route awg || active=
            ;;
        naive)
            naive_alive=1
            apply_route naive || active=
            ;;
        wan)
            apply_route wan || active=
            ;;
        olcrtc)
            active=
            ;;
    esac
}

# netifd builds awg0 at boot. If that setup fails the device never appears at
# all, and probe_iface() — which starts with `ip link show` — calls the tier
# dead without anyone ever retrying: nothing else here runs ifup. The router
# then latches on a lower tier for good, which is what a reboot during an
# upstream outage produced. Ask netifd for the device before judging the tier.
ensure_awg() {
    ip link show "$AWG_IFACE" >/dev/null 2>&1 && return 0
    [ -n "$AWG_UCI_IFACE" ] || return 1

    ensure_now=$(date +%s)
    [ $((ensure_now - awg_last_ifup)) -ge "$AWG_IFUP_HOLDDOWN" ] || return 1
    awg_last_ifup=$ensure_now

    event "ifup:$AWG_UCI_IFACE"
    ifup "$AWG_UCI_IFACE" >/dev/null 2>&1
    wait_for_iface "$AWG_IFACE" "$AWG_IFUP_TIMEOUT"
}

run_cycle() {
    ensure_awg
    if probe_iface "$AWG_IFACE"; then awg_result=1; else awg_result=0; fi
    record_result awg "$awg_result" "$FAIL_THRESHOLD" "$SUCCESS_THRESHOLD"

    if probe_iface "$NAIVE_IFACE"; then naive_result=1; else naive_result=0; fi
    record_result naive "$naive_result" "$FAIL_THRESHOLD" "$SUCCESS_THRESHOLD"

    if needs_olcrtc "$awg_alive" "$naive_alive"; then
        if [ "$olcrtc_started" = 1 ] || start_olcrtc_stack; then
            if probe_iface "$OLCRTC_IFACE"; then olcrtc_result=1; else olcrtc_result=0; fi
            record_result olcrtc "$olcrtc_result" "$FAIL_THRESHOLD" "$SUCCESS_THRESHOLD"
        else
            olcrtc_alive=0
        fi
    else
        olcrtc_alive=0
    fi

    wanted=$(desired_target "$awg_alive" "$naive_alive" "$olcrtc_alive")

    # netifd re-installs the uci split routes via awg0 on any network reload,
    # silently undoing a naive/olcrtc/wan decision. Compare the actual route
    # device with the desired one, not only our own remembered state — or a
    # reload while awg is dead black-holes all traffic until awg recovers.
    desired_dev=""
    case "$wanted" in
        awg) desired_dev=$AWG_IFACE ;;
        naive) desired_dev=$NAIVE_IFACE ;;
        olcrtc) desired_dev=$OLCRTC_IFACE ;;
    esac
    cur_dev=$(ip route show "$SPLIT_ROUTE_A" 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' | head -n1)

    if [ "$wanted" != "$active" ]; then
        if change_allowed "$wanted"; then
            apply_route "$wanted" || log "failed to apply target=$wanted"
        fi
    elif [ "$cur_dev" != "$desired_dev" ]; then
        # Same tier, but something else moved the routes. Re-assert now:
        # holddown guards against flapping between tiers, not against
        # restoring the decision already in force.
        apply_route "$wanted" || log "failed to re-apply target=$wanted"
    fi

    if ! needs_olcrtc "$awg_alive" "$naive_alive" && [ "$active" != olcrtc ]; then
        stop_olcrtc_stack
    fi
}

wait_interval() {
    [ "$no_sleep" = 1 ] && return 0
    wait_left=$CHECK_INTERVAL
    while [ "$wait_left" -gt 0 ]; do
        [ "$early_check" = 1 ] && break
        sleep 1
        wait_left=$((wait_left - 1))
    done
    early_check=0
}

printf '%s\n' "$$" > "$PID_FILE"
restore_state

cycle=0
while :; do
    cycle=$((cycle + 1))
    VPN_FAILOVER_CYCLE=$cycle
    export VPN_FAILOVER_CYCLE
    run_cycle

    if [ "$max_cycles" -gt 0 ] && [ "$cycle" -ge "$max_cycles" ]; then
        break
    fi
    wait_interval
done
