#!/usr/bin/env bash
# Runs every profile. Needs: Linux, sudo, tc (iproute2), ethtool, Node ≥ 18 and a Playwright Chromium
# (`npx playwright-core install chromium`).
# Usage: bench/sim/run-all.sh [refreshes=40] [uploads=30]
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT=bench/results/sim-raw.csv
rm -f "$OUT"
npm run build >/dev/null
sudo bench/sim/netem.sh setup
npx tsx bench/sim/server.ts 10.77.0.1 8080 > bench/results/sim-server.log 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; sudo bench/sim/netem.sh teardown' EXIT
sleep 2
for p in wifi 4g 3g edge lossy; do
  sudo bench/sim/netem.sh "$p"
  sudo ip netns exec ggs sudo -u "$USER" env HOME="$HOME" PATH="$PATH" node bench/sim/run.mjs "$p" http://10.77.0.1:8080 "$OUT" "${1:-40}" "${2:-30}"
done
