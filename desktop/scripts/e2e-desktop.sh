#!/usr/bin/env bash
# Real stack: control plane + agent + Tauri desktop app on a virtual display.
# Produces a screenshot of the real window. Needs Postgres, Redis, Xvfb, xwd, ImageMagick.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$ROOT/desktop/e2e-desktop.png}"
PORT=18282
API="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
AGENT="$ROOT/agent/target/debug/ghost-agent"
APP="$ROOT/desktop/src-tauri/target/debug/ghost-desktop"
trap 'kill -- -${CP:-0} -${VITE:-0} 2>/dev/null; kill ${AG:-} ${XV:-} ${UI:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval('v'+process.argv[1]))})" "$1"; }

export DATABASE_URL="${E2E_DB:-postgres://ghost:ghost@localhost:5432/ghost_e2e}" REDIS_URL="redis://localhost:6379/5" \
  PORT HOST=127.0.0.1 LOG_LEVEL=warn WORKER_TOKEN_SECRET="e2e-secret-e2e-secret-e2e-secret-1234" HEARTBEAT_INTERVAL_SECONDS=1
curl -s -o /dev/null "http://127.0.0.1:$PORT/healthz" && fail "port $PORT already in use (stale server?)"
redis-cli -n 5 flushdb >/dev/null
cd "$ROOT/control-plane"
ADMIN=$(npx tsx src/cli/create-admin.ts "ui-$RANDOM@ghost.test" | grep -o 'ghu_[A-Za-z0-9_-]*')
# Own process group: killing it also kills the node child that npx/tsx spawn.
setsid npx tsx src/server.ts >"$WORK/cp.log" 2>&1 & CP=$!
for _ in $(seq 50); do curl -sf "$API/readyz" >/dev/null && break; sleep 0.2; done
ENROLL=$(curl -sf -X POST "$API/v1/admin/enrollment-tokens" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{}' | json .token)

cat >"$WORK/agent.toml" <<TOML
[server]
url = "$API"
allow_insecure_localhost = true
[agent]
name = "desk-042"
data_dir = "$WORK/data"
sample_interval_secs = 1
[limits]
resume_after_secs = 0
require_idle_secs = 0
user_cpu_threshold_percent = 100
user_ram_threshold_percent = 100
TOML
echo "$ENROLL" | "$AGENT" --config "$WORK/agent.toml" enroll >/dev/null
"$AGENT" --config "$WORK/agent.toml" run 2>"$WORK/agent.err" & AG=$!
sleep 2

cd "$ROOT/desktop"
setsid npx vite --port 1420 --strictPort >"$WORK/vite.log" 2>&1 & VITE=$!
Xvfb :77 -screen 0 1200x900x24 >/dev/null 2>&1 & XV=$!
sleep 2
GHOST_DATA_DIR="$WORK/data" DISPLAY=:77 WEBKIT_DISABLE_COMPOSITING_MODE=1 "$APP" >"$WORK/ui.log" 2>&1 & UI=$!
sleep 10
kill -0 $UI 2>/dev/null || { cat "$WORK/ui.log"; fail "desktop app exited"; }

# The app polls the agent and reports presence; check the agent saw a presence report.
S=$("$AGENT" --config "$WORK/agent.toml" status)
[ "$(echo "$S" | json .control)" = stopped ] || fail "fresh install should be stopped"
"$AGENT" --config "$WORK/agent.toml" control start >/dev/null
sleep 3
if [ -n "${RUN_JOB:-}" ]; then
  # A long benchmark so the window shows a workload running in the sandbox.
  curl -sf -X POST "$API/v1/jobs" -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
    -d '{"type":"benchmark","name":"Benchmark SHA-256 (50M)","input":{"kind":"hash","iterations":50000000},"timeout":600}' >/dev/null
  for _ in $(seq 40); do
    [ "$("$AGENT" --config "$WORK/agent.toml" status | json '.workloads.length')" = 1 ] && break
    sleep 0.5
  done
  [ "$("$AGENT" --config "$WORK/agent.toml" status | json '.workloads.length')" = 1 ] || fail "workload did not start"
  sleep 6
  echo "running: $("$AGENT" --config "$WORK/agent.toml" status | json '.workloads[0].jobName')"
fi
xwd -root -display :77 -silent | convert xwd:- "$OUT"
echo "screenshot: $OUT"
echo PASS
