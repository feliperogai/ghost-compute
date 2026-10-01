#!/usr/bin/env bash
# Runs the server install guide (README, step 1) against the real image:
# docker compose up, create-admin, API with the admin token, web dashboard.
# Also checks that Postgres and Redis are published on loopback only.
# Usage (from control-plane/): scripts/compose-smoke.sh
#   KEEP=1 leaves the stack up; NO_BUILD=1 reuses an image already built.
set -euo pipefail
cd "$(dirname "$0")/.."

export WORKER_TOKEN_SECRET="${WORKER_TOKEN_SECRET:-$(openssl rand -hex 32)}"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ghost-smoke}"
API=http://127.0.0.1:8080

fail() { echo "FAIL: $*" >&2; docker compose logs control-plane | tail -50 >&2; exit 1; }
cleanup() { [ "${KEEP:-}" = 1 ] || docker compose down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

[ "${NO_BUILD:-}" = 1 ] || docker compose build
docker compose up -d --wait --wait-timeout 180 || fail "stack did not become healthy"

for svc in postgres redis; do
  bindings=$(docker compose port "$svc" "$([ $svc = postgres ] && echo 5432 || echo 6379)")
  [[ "$bindings" == 127.0.0.1:* ]] || fail "$svc is published on $bindings (expected 127.0.0.1 only)"
done

[ "$(curl -fsS $API/healthz)" = '{"status":"ok"}' ] || fail "/healthz"

out=$(docker compose exec -T control-plane node dist/src/cli/create-admin.js "smoke-$(date +%s)@example.com") ||
  fail "create-admin: $out"
token=$(sed -n 's/^api token (shown once): \(ghu_[^ ]*\)$/\1/p' <<<"$out")
[ -n "$token" ] || fail "create-admin printed no token: $out"

curl -fsS -H "authorization: Bearer $token" $API/v1/me | grep -q '"role":"admin"' || fail "/v1/me with the admin token"
curl -fsS -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d '{"note":"smoke"}' \
  $API/v1/provider/enrollment-tokens | grep -q '"token":"ghe_' || fail "enrollment token (install guide, step 2)"

curl -fsS $API/dashboard/ | grep -qi '<div id="root"' || fail "/dashboard/ does not serve the web dashboard"

echo "compose smoke: OK"
