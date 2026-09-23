#!/usr/bin/env bash
# Rebuilds the built-in workloads embedded in the agent's sandbox.
# The agent pins each module's SHA-256; update it in agent/src/execution/registry.rs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT="$ROOT/../agent/workloads"
mkdir -p "$OUT"
for w in benchmark image-inference; do
  (cd "$ROOT/$w" && cargo build --release --target wasm32-unknown-unknown -q)
  src="$ROOT/$w/target/wasm32-unknown-unknown/release/ghost_workload_${w//-/_}.wasm"
  cp "$src" "$OUT/$w.wasm"
done
sha256sum "$OUT"/*.wasm
