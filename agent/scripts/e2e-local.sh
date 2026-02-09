#!/usr/bin/env bash
# End-to-end: real control plane + real agent binary.
# Needs local Postgres/Redis (see control-plane/README.md) and `cargo build`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PORT:-18181}"
DB="${E2E_DB:-postgres://ghost:ghost@localhost:5432/ghost_e2e}"
WORK="$(mktemp -d)"
AGENT="$ROOT/agent/target/debug/ghost-agent"
API="http://127.0.0.1:$PORT"
trap 'kill ${CP_PID:-} ${AG_PID:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s);console.log(eval('v'+process.argv[1]))})" "$1"; }

export DATABASE_URL="$DB" REDIS_URL="redis://localhost:6379/4" PORT HOST=127.0.0.1 LOG_LEVEL=warn \
  WORKER_TOKEN_SECRET="e2e-secret-e2e-secret-e2e-secret-1234" HEARTBEAT_INTERVAL_SECONDS=1 WORKER_OFFLINE_AFTER_SECONDS=10
redis-cli -n 4 flushdb >/dev/null

cd "$ROOT/control-plane"
ADMIN=$(npx tsx src/cli/create-admin.ts "e2e-$RANDOM@ghost.test" | grep -o 'ghu_[A-Za-z0-9_-]*')
npx tsx src/server.ts >"$WORK/cp.log" 2>&1 & CP_PID=$!
for _ in $(seq 50); do curl -sf "$API/readyz" >/dev/null && break; sleep 0.2; done
curl -sf "$API/readyz" >/dev/null || fail "control plane did not start"

ENROLL=$(curl -sf -X POST "$API/v1/admin/enrollment-tokens" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{}' | json .token)

cat >"$WORK/agent.toml" <<TOML
[server]
url = "$API"
allow_insecure_localhost = true

[agent]
name = "e2e-desktop"
data_dir = "$WORK/data"
sample_interval_secs = 1

[limits]
resume_after_secs = 0
require_idle_secs = 0
user_cpu_threshold_percent = 100
user_ram_threshold_percent = 100
pause_on_battery = false
TOML

echo "== enroll"
echo "$ENROLL" | "$AGENT" --config "$WORK/agent.toml" enroll
WID=$(json .workerId <"$WORK/data/credentials.json")
DID=$(json .deviceId <"$WORK/data/identity.json")
echo "worker=$WID device=$DID"
echo "$ENROLL" | "$AGENT" --config "$WORK/agent.toml" enroll 2>/dev/null && fail "second enroll must be refused"

echo "== run + heartbeat"
GHOST_LOG=info "$AGENT" --config "$WORK/agent.toml" run 2>"$WORK/agent.err" & AG_PID=$!
sleep 3
W=$(curl -sf "$API/v1/workers/$WID" -H "authorization: Bearer $ADMIN")
echo "$W" | json '.state' | grep -qx stopped || fail "fresh install must start stopped: $W"
echo "state=stopped until the owner starts sharing"

echo "== control via local IPC"
"$AGENT" --config "$WORK/agent.toml" control start
sleep 2
S=$("$AGENT" --config "$WORK/agent.toml" status)
[ "$(echo "$S" | json .control)" = started ] || fail "control not applied: $S"
[ "$(echo "$S" | json .connection.status)" = connected ] || fail "not connected: $S"
[ -n "${FIXTURE_OUT:-}" ] && echo "$S" >"$FIXTURE_OUT"
W=$(curl -sf "$API/v1/workers/$WID" -H "authorization: Bearer $ADMIN")
echo "$W" | json '.state' | grep -qx waiting || fail "expected state waiting: $W"
[ "$(echo "$W" | json .deviceId)" = "$DID" ] || fail "device id mismatch"
echo "$W" | json '.lastUsage.cpuPercent' | grep -qE '^[0-9.]+$' || fail "no usage: $W"
echo "$W" | json '.hardware.cpu.threads' | grep -qE '^[1-9]' || fail "no hardware: $W"
echo "state=waiting (execution unavailable) usage=$(echo "$W" | json '.lastUsage')"

echo "== revoke"
curl -sf -X POST "$API/v1/workers/$WID/revoke" -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"reason":"e2e"}' >/dev/null
set +e; timeout 15 tail --pid=$AG_PID -f /dev/null; wait $AG_PID; CODE=$?; set -e
[ "$CODE" = 3 ] || fail "agent exit code $CODE, expected 3 (revoked)"
[ ! -f "$WORK/data/credentials.json" ] || fail "credentials not deleted after revocation"

echo "== logs"
LOG=$(ls "$WORK"/data/logs/agent.*log | head -1)
head -1 "$LOG" | node -e "JSON.parse(require('fs').readFileSync(0,'utf8'))" || fail "log is not JSON"
if grep -q 'ghw_\|ghe_\|v1\.ey' "$LOG" "$WORK/agent.err"; then fail "secret leaked into logs"; fi

echo "PASS"
