#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/compose.yaml"
SERVICE="${1:-}"
API_HEALTH_URL="${API_HEALTH_URL:-http://localhost:4000/api/health}"
RESTORED=false

case "$SERVICE" in
  postgres | redis | minio | elasticsearch) ;;
  *)
    echo "Usage: DRILL_CONFIRM=knowledge-base $0 <postgres|redis|minio|elasticsearch>" >&2
    exit 1
    ;;
esac
if [[ "${DRILL_CONFIRM:-}" != "knowledge-base" ]]; then
  echo "Set DRILL_CONFIRM=knowledge-base to acknowledge temporary dependency interruption" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

http_code() {
  curl --silent --output /dev/null --connect-timeout 2 --max-time 5 --write-out '%{http_code}' \
    "$API_HEALTH_URL" || true
}

wait_for_code() {
  local expected="$1"
  local attempts="${2:-45}"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if [[ "$(http_code)" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for health HTTP $expected" >&2
  return 1
}

restore_service() {
  if [[ "$RESTORED" != "true" ]]; then
    compose start "$SERVICE" >/dev/null
    RESTORED=true
  fi
}
trap restore_service EXIT INT TERM

wait_for_code 200 5
compose stop "$SERVICE" >/dev/null
wait_for_code 503
restore_service
wait_for_code 200
trap - EXIT INT TERM

echo "Dependency drill passed: $SERVICE caused health degradation and recovered"
