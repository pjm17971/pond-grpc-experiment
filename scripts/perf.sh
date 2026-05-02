#!/usr/bin/env bash
# `pnpm perf` — run the canonical performance suite the standing-rule
# memory describes (`profiling_workflow.md`):
#
#   - Four bench:agg load points (9k/s, 87k/s, 92k×1k, 1M target)
#   - One profile-agg run at the ceiling regime
#
# All results stream to stdout; profiles land in /tmp/agg-prof.
# Walk-away script — runs end-to-end without further input.

set -euo pipefail
cd "$(dirname "$0")/.."

# Each bench: 30s window + ~5s warmup + ~5s spin-up = ~40s wall-clock.
# Four runs ≈ 2:40, plus one 20s+overhead profile = ~3:30 total.
SECS=${PERF_SECONDS:-30}

echo "── perf suite — bench (${SECS}s) × 4 + profile (20s) ──"
echo

for cfg in \
    "P=100 N=100" \
    "P=100 N=1000" \
    "P=1000 N=100" \
    "P=1000 N=1000"
do
  read -ra parts <<< "$cfg"
  P=${parts[0]}; N=${parts[1]}
  echo "=== bench ${P} × ${N} ==="
  pnpm --filter @pond-experiment/aggregator bench:agg "--${P}" "--${N}" "--seconds=${SECS}"
  echo
done

echo "=== profile-agg at ceiling (P=1000 × N=1000, 20s) ==="
rm -f /tmp/agg-prof/*.cpuprofile 2>/dev/null || true
pnpm --filter @pond-experiment/aggregator exec tsx scripts/profile-agg.ts \
  --P=1000 --N=1000 --seconds=20

echo
echo "── done ──"
echo "Profiles in /tmp/agg-prof/"
ls -la /tmp/agg-prof/ 2>/dev/null || true
echo
echo "To analyze the largest (the aggregator):"
echo "  node packages/aggregator/scripts/analyze-cpuprofile.mjs <largest-cpuprofile>"
