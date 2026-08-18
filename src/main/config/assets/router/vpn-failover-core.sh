#!/bin/sh

desired_target() {
    [ "$1" = 1 ] && {
        printf '%s\n' awg
        return 0
    }
    [ "$2" = 1 ] && {
        printf '%s\n' naive
        return 0
    }
    [ "$3" = 1 ] && {
        printf '%s\n' olcrtc
        return 0
    }
    printf '%s\n' wan
}

needs_olcrtc() {
    [ "$1" = 0 ] && [ "$2" = 0 ]
}

record_result() {
    local rf_prefix=$1
    local rf_result=$2
    local rf_fail_limit=$3
    local rf_success_limit=$4
    local rf_fails rf_oks rf_alive

    eval "rf_fails=\${${rf_prefix}_fails}"
    eval "rf_oks=\${${rf_prefix}_oks}"
    eval "rf_alive=\${${rf_prefix}_alive}"

    if [ "$rf_result" = 1 ]; then
        rf_oks=$((rf_oks + 1))
        rf_fails=0
        [ "$rf_oks" -ge "$rf_success_limit" ] && rf_alive=1
    else
        rf_fails=$((rf_fails + 1))
        rf_oks=0
        [ "$rf_fails" -ge "$rf_fail_limit" ] && rf_alive=0
    fi

    eval "${rf_prefix}_fails=$rf_fails"
    eval "${rf_prefix}_oks=$rf_oks"
    eval "${rf_prefix}_alive=$rf_alive"
}
