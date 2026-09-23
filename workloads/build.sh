#!/usr/bin/env bash
# Rebuilds the built-in workloads embedded in the agent's sandbox.
# The agent pins each module's SHA-256; update it in agent/src/execution/registry.rs.
set -euo pipefail
cd "$(dirname "$0")/benchmark"
cargo build --release --target wasm32-unknown-unknown -q
OUT=../../agent/workloads/benchmark.wasm
mkdir -p "$(dirname "$OUT")"
cp target/wasm32-unknown-unknown/release/ghost_workload_benchmark.wasm "$OUT"
sha256sum "$OUT"
