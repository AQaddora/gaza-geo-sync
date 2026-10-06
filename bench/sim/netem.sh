#!/usr/bin/env bash
# Network profiles for the simulation, applied with tc-netem on a veth pair between the
# root namespace (server, 10.77.0.1) and a namespace "ggs" (browser, 10.77.0.2).
# Usage: sudo bench/sim/netem.sh setup | <profile> | teardown
# Profiles (down/up kbit/s, round trip, random loss each way):
#   wifi   30000/15000  20 ms   0%    good home/office Wi-Fi
#   4g      9000/9000  170 ms   0%    WebPageTest "4G"
#   3g      1600/768   300 ms   0%    WebPageTest "3G"
#   edge     240/200   840 ms   0%    WebPageTest "Edge" (2G/EDGE-class)
#   lossy   1600/768   300 ms   3%    3G with 3% random packet loss in each direction
set -euo pipefail
NS=ggs
case "${1:-}" in
  setup)
    ip netns add $NS 2>/dev/null || true
    ip link add ggs-host type veth peer name ggs-ns 2>/dev/null || true
    ip link set ggs-ns netns $NS 2>/dev/null || true
    ip addr replace 10.77.0.1/24 dev ggs-host
    ip link set ggs-host up
    ip netns exec $NS ip addr replace 10.77.0.2/24 dev ggs-ns
    ip netns exec $NS ip link set ggs-ns up
    ip netns exec $NS ip link set lo up
    # Real MTU-sized packets, so netem's rate and loss act per packet.
    ethtool -K ggs-host tso off gso off gro off >/dev/null 2>&1 || true
    ip netns exec $NS ethtool -K ggs-ns tso off gso off gro off >/dev/null 2>&1 || true
    ;;
  teardown)
    ip link del ggs-host 2>/dev/null || true
    ip netns del $NS 2>/dev/null || true
    ;;
  *)
    case "$1" in
      wifi)  DOWN=30000; UP=15000; RTT=20;  LOSS=0 ;;
      4g)    DOWN=9000;  UP=9000;  RTT=170; LOSS=0 ;;
      3g)    DOWN=1600;  UP=768;   RTT=300; LOSS=0 ;;
      edge)  DOWN=240;   UP=200;   RTT=840; LOSS=0 ;;
      lossy) DOWN=1600;  UP=768;   RTT=300; LOSS=3 ;;
      *) echo "unknown profile $1" >&2; exit 2 ;;
    esac
    HALF=$((RTT / 2))
    # Downlink: server → browser leaves through ggs-host. Uplink: browser → server leaves through ggs-ns.
    tc qdisc replace dev ggs-host root netem delay ${HALF}ms loss ${LOSS}% rate ${DOWN}kbit limit 10000
    ip netns exec $NS tc qdisc replace dev ggs-ns root netem delay ${HALF}ms loss ${LOSS}% rate ${UP}kbit limit 10000
    echo "profile $1: down ${DOWN} kbit/s, up ${UP} kbit/s, RTT ${RTT} ms, loss ${LOSS}%"
    ;;
esac
