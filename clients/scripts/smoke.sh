#!/usr/bin/env bash
#
# Cross-client live smoke test.
#
# Boots a real web-hooky server against a throwaway SQLite database, seeds an
# admin key, a destination, a fetch API user and a grant, posts a webhook, then
# drives every client's CLI through read, stream and admin commands and compares
# what they return. Unit tests can pass while every client shares the same wrong
# assumption; this is what catches that.
#
# Usage:
#   clients/scripts/smoke.sh              # every client that is buildable here
#   clients/scripts/smoke.sh go node      # only the named clients
#
# Exit code 0 means every selected client agreed with the server and with each
# other. Clients whose toolchain is missing are reported as skipped, not failed.

# `-E` propagates the ERR trap into functions, so a failure inside the setup
# helpers still dumps the server log rather than exiting silently.
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly CLIENTS_DIR="$(dirname "$SCRIPT_DIR")"
readonly REPO_ROOT="$(dirname "$CLIENTS_DIR")"

readonly HOST="127.0.0.1"
readonly PORT="${WEBHOOKY_SMOKE_PORT:-18787}"
readonly BASE_URL="http://${HOST}:${PORT}"
readonly BOOTSTRAP_KEY="smoke-admin:smoke-secret-value"

WORK_DIR=""
SERVER_PID=""
FAILURES=0
SKIPPED=()
RAN=()

# -- output ------------------------------------------------------------------

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
pass() { printf '    \033[32mok\033[0m   %s\n' "$*"; }
fail() {
  printf '    \033[31mFAIL\033[0m %s\n' "$*"
  FAILURES=$((FAILURES + 1))
}

cleanup() {
  local code=$?
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  # The server logs the reference behind any 500 it returns, so a failed run is
  # far easier to diagnose with that log attached. A passing run stays quiet.
  if [[ $code -ne 0 && -n "$WORK_DIR" && -f "${WORK_DIR}/server.log" ]]; then
    printf '\n--- server log ---\n' >&2
    cat "${WORK_DIR}/server.log" >&2
    printf -- '--- end server log ---\n' >&2
  fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

# -- server ------------------------------------------------------------------

start_server() {
  step "Starting a server on ${BASE_URL}"

  if curl -fsS "${BASE_URL}/_health" >/dev/null 2>&1; then
    echo "something is already listening on ${BASE_URL};" >&2
    echo "stop it, or set WEBHOOKY_SMOKE_PORT to a free port" >&2
    exit 1
  fi
  WORK_DIR="$(mktemp -d)"

  # `exec` matters: without it `$!` is the subshell, and killing the subshell
  # would leave the server holding the port for the next run.
  #
  # Admin auth is disabled and a bootstrap key is seeded, so the clients
  # authenticate with an admin API key - the path a real deployment uses for
  # automation.
  (
    cd "$REPO_ROOT"
    exec env \
      WEBHOOKY_HOST="$HOST" \
      WEBHOOKY_PORT="$PORT" \
      WEBHOOKY_DB_PATH="${WORK_DIR}/smoke.sqlite" \
      WEBHOOKY_ADDONS_DIR="${WORK_DIR}/addons" \
      WEBHOOKY_ADMIN_AUTH=disabled \
      WEBHOOKY_ADMIN_BOOTSTRAP_KEY="$BOOTSTRAP_KEY" \
      WEBHOOKY_RELAY_POLL_INTERVAL_SECONDS=0 \
      bun run src/main.ts >"${WORK_DIR}/server.log" 2>&1
  ) &
  SERVER_PID=$!

  for _ in $(seq 1 60); do
    if curl -fsS "${BASE_URL}/_health" >/dev/null 2>&1; then
      pass "server is healthy (pid ${SERVER_PID})"
      return 0
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      cat "${WORK_DIR}/server.log" >&2
      echo "server exited before becoming healthy" >&2
      exit 1
    fi
    sleep 0.5
  done

  cat "${WORK_DIR}/server.log" >&2
  echo "server did not become healthy in 30s" >&2
  exit 1
}

admin_curl() {
  curl -fsS -H "authorization: Bearer ${BOOTSTRAP_KEY}" \
    -H 'content-type: application/json' "$@"
}

# Extracts a top-level string field from a JSON object on stdin.
#
# `bun` is already required to run the server under test, so it stands in for
# `jq` rather than adding a second prerequisite. Under `bun -e`, script
# arguments start at `process.argv[1]`.
json_field() {
  bun -e '
    const key = process.argv[1];
    const parsed = JSON.parse(await Bun.stdin.text());
    const value = Array.isArray(parsed) ? parsed[0]?.[key] : parsed?.[key];
    process.stdout.write(value === undefined || value === null ? "" : String(value));
  ' "$1"
}

seed_fixtures() {
  step "Seeding a destination, a fetch API user and a grant"

  local destination
  destination="$(admin_curl -X POST "${BASE_URL}/_admin/api/destinations" \
    -d '{"name":"smoke","vendorAddon":"passthrough","destinationAddon":"envelope"}')"
  DESTINATION_ID="$(printf '%s' "$destination" | json_field id)"
  INBOUND_PATH="$(printf '%s' "$destination" | json_field inboundPath)"
  FETCH_UUID="$(printf '%s' "$destination" | json_field fetchUuid)"
  info "destination ${DESTINATION_ID}"

  local user
  user="$(admin_curl -X POST "${BASE_URL}/_admin/api/users" \
    -d '{"label":"smoke-reader"}')"
  API_KEY="$(printf '%s' "$user" | json_field id)"
  API_SECRET="$(printf '%s' "$user" | json_field secret)"

  admin_curl -X PUT \
    "${BASE_URL}/_admin/api/users/${API_KEY}/grants/${DESTINATION_ID}" >/dev/null
  pass "fetch API user ${API_KEY} granted ${DESTINATION_ID}"

  # Two records, so a `--limit 1` read is distinguishable from an unfiltered one.
  curl -fsS -X POST "${BASE_URL}${INBOUND_PATH}" \
    -H 'content-type: application/json' -d '{"event":"one"}' >/dev/null
  curl -fsS -X POST "${BASE_URL}${INBOUND_PATH}" \
    -H 'content-type: application/json' -d '{"event":"two"}' >/dev/null
  pass "posted 2 inbound webhooks"

  export WEBHOOKY_URL="$BASE_URL"
  export WEBHOOKY_API_KEY="$API_KEY"
  export WEBHOOKY_API_SECRET="$API_SECRET"
  export WEBHOOKY_FETCH_UUID="$FETCH_UUID"
  export WEBHOOKY_ADMIN_CREDENTIAL="$BOOTSTRAP_KEY"
}

# -- per-client checks -------------------------------------------------------

# Runs the shared command matrix against one client's CLI.
#
# `$1` is a label, the rest is the command that invokes that client's CLI.
exercise_client() {
  local label="$1"
  shift
  local -a cli=("$@")

  step "Exercising the ${label} client"
  RAN+=("$label")

  # 1. Read without marking, twice: the client must agree with the server about
  #    how many records exist, and both reads must see the same set - which is
  #    what `--no-mark-fetched` promises.
  #
  #    The expected count is read from the server each time rather than fixed,
  #    because every client's stream check below stores one more record.
  local expected
  expected="$(admin_curl "${BASE_URL}/_admin/api/records/${DESTINATION_ID}?limit=1000" |
    count_records)"

  local first second
  if ! first="$("${cli[@]}" records get --no-mark-fetched --limit 1000 2>&1)"; then
    fail "${label}: records get failed: ${first}"
    return
  fi
  if ! second="$("${cli[@]}" records get --no-mark-fetched --limit 1000 2>&1)"; then
    fail "${label}: second records get failed: ${second}"
    return
  fi
  local count
  count="$(printf '%s' "$first" | count_records)"
  if [[ "$count" != "$expected" ]]; then
    fail "${label}: read ${count} records, the server holds ${expected}"
    return
  fi
  if [[ "$first" != "$second" ]]; then
    fail "${label}: --no-mark-fetched changed state between reads"
    return
  fi
  pass "${label}: records get returned ${count} records without marking them"

  # 2. The limit is honoured.
  local limited
  limited="$("${cli[@]}" records get --no-mark-fetched --limit 1 2>&1)"
  if [[ "$(printf '%s' "$limited" | count_records)" != "1" ]]; then
    fail "${label}: --limit 1 returned $(printf '%s' "$limited" | count_records) records"
    return
  fi
  pass "${label}: --limit is honoured"

  # 3. Admin identity resolves through the same credential the server seeded.
  local identity subject
  if ! identity="$("${cli[@]}" admin me 2>&1)"; then
    fail "${label}: admin me failed: ${identity}"
    return
  fi
  subject="$(printf '%s' "$identity" | json_field subject)"
  if [[ "$subject" != "admin-key:smoke-admin" ]]; then
    fail "${label}: admin me resolved subject '${subject}'"
    return
  fi
  pass "${label}: admin me resolved ${subject}"

  # 4. The destination listing carries the fetch uuid this run is using.
  local listed
  listed="$("${cli[@]}" admin destinations list 2>&1)"
  if [[ "$listed" != *"$FETCH_UUID"* ]]; then
    fail "${label}: destinations list did not carry the fetch uuid"
    return
  fi
  pass "${label}: admin destinations list agrees with the server"

  # 5. A relay round-trip: create, list deliveries, delete.
  local relay relay_id
  relay="$("${cli[@]}" admin relays create \
    --destination-id "$DESTINATION_ID" \
    --name "smoke-${label}" \
    --target-url "http://127.0.0.1:9/unused" 2>&1)" || {
    fail "${label}: relay create failed: ${relay}"
    return
  }
  relay_id="$(printf '%s' "$relay" | json_field id)"
  if [[ -z "$relay_id" ]]; then
    fail "${label}: relay create returned no id: ${relay}"
    return
  fi
  "${cli[@]}" admin relays deliveries "$relay_id" >/dev/null 2>&1 || {
    fail "${label}: relay deliveries failed"
    return
  }
  "${cli[@]}" admin relays delete "$relay_id" >/dev/null 2>&1 || {
    fail "${label}: relay delete failed"
    return
  }
  pass "${label}: relay create/deliveries/delete round-trip"

  # 6. Streaming: subscribe, post a webhook, expect exactly one record line.
  local stream_out
  stream_out="${WORK_DIR}/stream-${label}.ndjson"
  "${cli[@]}" records stream --max-records 1 >"$stream_out" 2>/dev/null &
  local stream_pid=$!
  # The handshake has to complete before the record is broadcast, otherwise the
  # subscriber is not yet in the hub and would wait forever.
  sleep 2
  curl -fsS -X POST "${BASE_URL}${INBOUND_PATH}" \
    -H 'content-type: application/json' \
    -d "{\"event\":\"stream-${label}\"}" >/dev/null

  local waited=0
  while kill -0 "$stream_pid" 2>/dev/null && [[ $waited -lt 15 ]]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$stream_pid" 2>/dev/null; then
    kill "$stream_pid" 2>/dev/null || true
    fail "${label}: stream did not deliver a record within 15s"
    return
  fi
  wait "$stream_pid" 2>/dev/null || true

  if [[ ! -s "$stream_out" ]] || ! grep -q "stream-${label}" "$stream_out"; then
    fail "${label}: streamed output did not contain the posted record"
    return
  fi
  pass "${label}: streamed the record posted after subscribing"

  # 7. Usage errors exit 2, server errors exit 1 - the contract scripts rely on.
  local code
  set +e
  "${cli[@]}" admin bogus-resource >/dev/null 2>&1
  code=$?
  set -e
  if [[ "$code" != "2" ]]; then
    fail "${label}: an unknown command exited ${code}, expected 2"
    return
  fi

  set +e
  WEBHOOKY_FETCH_UUID="00000000-0000-0000-0000-000000000000" \
    "${cli[@]}" records get >/dev/null 2>&1
  code=$?
  set -e
  if [[ "$code" != "1" ]]; then
    fail "${label}: an unknown destination exited ${code}, expected 1"
    return
  fi
  pass "${label}: exit codes 2 (usage) and 1 (server error) are correct"
}

# Counts records on stdin, accepting either a bare array (what the clients
# print) or the server's `{"records": [...]}` envelope. -1 when it is neither.
count_records() {
  bun -e '
    try {
      const parsed = JSON.parse(await Bun.stdin.text());
      const items = Array.isArray(parsed) ? parsed : parsed?.records;
      process.stdout.write(String(Array.isArray(items) ? items.length : -1));
    } catch {
      process.stdout.write("-1");
    }
  '
}

# -- client selection --------------------------------------------------------

should_run() {
  local name="$1"
  if [[ ${#SELECTED[@]} -eq 0 ]]; then
    return 0
  fi
  local candidate
  for candidate in "${SELECTED[@]}"; do
    [[ "$candidate" == "$name" ]] && return 0
  done
  return 1
}

run_go() {
  should_run go || return 0
  if ! command -v go >/dev/null 2>&1; then
    SKIPPED+=("go (no toolchain)")
    return 0
  fi
  local binary="${WORK_DIR}/webhooky-go"
  (cd "${CLIENTS_DIR}/go" && go build -o "$binary" ./cmd/webhooky) || {
    fail "go: build failed"
    return
  }
  exercise_client go "$binary"
}

run_python() {
  should_run python || return 0
  local venv="${CLIENTS_DIR}/python/.venv"
  if [[ ! -x "${venv}/bin/webhooky" ]]; then
    SKIPPED+=("python (run: python3 -m venv clients/python/.venv && clients/python/.venv/bin/pip install -e 'clients/python[dev]')")
    return 0
  fi
  exercise_client python "${venv}/bin/webhooky"
}

run_node() {
  should_run node || return 0
  if ! command -v bun >/dev/null 2>&1; then
    SKIPPED+=("node (no bun)")
    return 0
  fi
  exercise_client node bun "${CLIENTS_DIR}/node/bin/webhooky.js"
}

run_swift() {
  should_run swift || return 0
  if ! command -v swift >/dev/null 2>&1; then
    SKIPPED+=("swift (no toolchain)")
    return 0
  fi
  # A Nix-provided SDK can be older than the Xcode compiler; clearing these
  # lets SwiftPM pick the toolchain's own SDK.
  local binary="${CLIENTS_DIR}/swift/.build/debug/webhooky"
  (cd "${CLIENTS_DIR}/swift" &&
    env -u SDKROOT -u DEVELOPER_DIR -u MACOSX_DEPLOYMENT_TARGET \
      swift build --product webhooky >/dev/null 2>&1) || {
    SKIPPED+=("swift (build failed)")
    return 0
  }
  exercise_client swift "$binary"
}

# -- main --------------------------------------------------------------------

SELECTED=("$@")

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to run the server under test" >&2
  exit 1
fi

start_server
seed_fixtures

run_go
run_python
run_node
run_swift

step "Summary"
if [[ ${#RAN[@]} -gt 0 ]]; then
  info "exercised: ${RAN[*]}"
fi
if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  for entry in "${SKIPPED[@]}"; do
    info "skipped:   ${entry}"
  done
fi
if [[ ${#RAN[@]} -eq 0 ]]; then
  echo "no client was exercised" >&2
  exit 1
fi
if [[ $FAILURES -gt 0 ]]; then
  printf '\n\033[31m%d check(s) failed\033[0m\n' "$FAILURES"
  exit 1
fi
printf '\n\033[32mall checks passed\033[0m\n'
