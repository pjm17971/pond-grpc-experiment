#!/usr/bin/env bash
# Node vs Rust aggregator race: the bench:full sweep (P x N), each config
# run once per aggregator, back to back (alternated), on the Rust
# producer so the producer is never the limit. Prints one bench:dev table
# row per run, prefixed with the aggregator.
#
#   packages/aggregator/scripts/race.sh [seconds=30] [rounds=1]
#
# Needs release builds of packages/producer-rs and packages/aggregator-rs.
set -euo pipefail
cd "$(dirname "$0")/../../.."
seconds=${1:-30}
rounds=${2:-1}
configs="10:1 10:10 10:100 10:1000 100:1 100:10 100:100 100:1000 1000:1 1000:10 1000:100 1000:1000"
for round in $(seq 1 "$rounds"); do
  for c in $configs; do
    P=${c%%:*}; N=${c##*:}
    for agg in node rust; do
      out=$(PRODUCER_IMPL=rust AGGREGATOR_IMPL=$agg pnpm --filter @pond-experiment/aggregator bench:dev \
        --P="$P" --N="$N" --seconds="$seconds" 2>&1 || true)
      row=$(grep -E '^\| *[0-9]' <<<"$out" | tail -1 || true)
      if [ -n "$row" ]; then
        echo "| $agg $row"
      else
        echo "| $agg | $P | $N | FAILED |"
        tail -5 <<<"$out" | sed 's/^/#   /'
      fi
    done
  done
done
