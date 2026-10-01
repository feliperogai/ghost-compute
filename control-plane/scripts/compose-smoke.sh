#!/usr/bin/env bash
# Runs the server install guide (README, step 1) against the real image:
# docker compose up, create-admin, two-step verification, API with the admin token, web dashboard.
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

# Staff must turn on two-step verification first (REQUIRE_STAFF_MFA, on by default).
status=$(curl -sS -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" $API/v1/workers)
[ "$status" = 403 ] || fail "staff without two-step verification got $status (expected 403)"
secret=$(curl -fsS -X POST -H "authorization: Bearer $token" $API/v1/me/mfa/totp | sed -n 's/.*"secret":"\([A-Z2-7]*\)".*/\1/p')
[ -n "$secret" ] || fail "two-step verification: no secret"
# What the authenticator app does: the code for the current 30 s step (+ ahead, codes work once).
totp() {
  docker compose exec -T control-plane node -e '
    const c = require("node:crypto"), a = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "", out = [];
    for (const ch of process.argv[1]) bits += a.indexOf(ch).toString(2).padStart(5, "0");
    for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + Number(process.argv[2])));
    const h = c.createHmac("sha1", Buffer.from(out)).update(msg).digest(), o = h[19] & 15;
    console.log(String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0"));' "$secret" "$1"
}
curl -fsS -X POST -H "authorization: Bearer $token" -H 'content-type: application/json' -d "{\"code\":\"$(totp 0)\"}" \
  $API/v1/me/mfa/totp/confirm | grep -q '"enabled":true' || fail "two-step verification: confirm"

curl -fsS -X POST -H "authorization: Bearer $token" -H "x-ghost-otp: $(totp 1)" -H 'content-type: application/json' -d '{"note":"smoke"}' \
  $API/v1/provider/enrollment-tokens | grep -q '"token":"ghe_' || fail "enrollment token (install guide, step 2)"

curl -fsS $API/dashboard/ | grep -qi '<div id="root"' || fail "/dashboard/ does not serve the web dashboard"

echo "compose smoke: OK"
