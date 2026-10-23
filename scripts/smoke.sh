#!/usr/bin/env bash
# Smoke test: exercises the whole API through whatever URL you give it.
#   ./scripts/smoke.sh http://localhost:3000        (backend directly)
#   ./scripts/smoke.sh http://localhost:8088        (through Caddy, local compose)
#   ./scripts/smoke.sh https://todo.lazuar.dev      (production)
#
# Optional second argument: the version (commit SHA) that must be running.
#   ./scripts/smoke.sh https://todo.lazuar.dev "$(git rev-parse HEAD)"
set -euo pipefail

BASE="${1:?usage: smoke.sh <base-url> [expected-version]}"
BASE="${BASE%/}"
EXPECT_VERSION="${2:-}"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

step "GET /api/health"
HEALTH=$(curl -fsS "$BASE/api/health") || fail "health request failed"
echo "$HEALTH"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' || fail "health check"
if [ -n "$EXPECT_VERSION" ]; then
  printf '%s' "$HEALTH" | grep -q "\"version\":\"$EXPECT_VERSION\"" \
    || fail "wrong version running: expected $EXPECT_VERSION"
fi

step "POST /api/todos"
CREATED=$(curl -fsS -X POST "$BASE/api/todos" \
  -H 'content-type: application/json' -d '{"title":"smoke test"}')
echo "$CREATED"
ID=$(printf '%s' "$CREATED" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
[ -n "$ID" ] || fail "could not read id from response"

step "GET /api/todos (must contain id $ID)"
curl -fsS "$BASE/api/todos" | grep -q "\"id\":$ID," || fail "created todo not listed"

step "PATCH /api/todos/$ID"
curl -fsS -X PATCH "$BASE/api/todos/$ID" \
  -H 'content-type: application/json' -d '{"done":true}' | grep -q '"done":true' \
  || fail "todo not marked done"

step "DELETE /api/todos/$ID"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/todos/$ID")
[ "$STATUS" = "204" ] || fail "delete returned $STATUS, expected 204"

step "Validation: empty title must be rejected"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/todos" \
  -H 'content-type: application/json' -d '{"title":""}')
[ "$STATUS" = "400" ] || fail "empty title returned $STATUS, expected 400"

printf '\nAll smoke checks passed against %s\n' "$BASE"
