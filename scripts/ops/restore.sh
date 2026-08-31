#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/compose.yaml"
BACKUP_DIR="${1:-}"

if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
  echo "Usage: RESTORE_CONFIRM=knowledge-base $0 <backup-directory>" >&2
  exit 1
fi
if [[ "${RESTORE_CONFIRM:-}" != "knowledge-base" ]]; then
  echo "Set RESTORE_CONFIRM=knowledge-base to acknowledge destructive restore" >&2
  exit 1
fi
if [[ -e "$BACKUP_DIR/.incomplete" ]]; then
  echo "Backup is incomplete: $BACKUP_DIR" >&2
  exit 1
fi

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

(
  cd "$BACKUP_DIR"
  shasum -a 256 -c SHA256SUMS
)

compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --exit-on-error --no-owner --no-privileges' \
  <"$BACKUP_DIR/postgres.dump"

compose run --rm --no-deps \
  -v "$BACKUP_DIR/minio:/backup:ro" \
  --entrypoint /bin/sh minio-client -c \
  'mc alias set target http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null && mc mb --ignore-existing "target/$MINIO_BUCKET" >/dev/null && mc mirror --overwrite --remove /backup "target/$MINIO_BUCKET"'

compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  <"$ROOT_DIR/scripts/ops/recover-ephemeral-state.sql"

if [[ "${RESTORE_REBUILD_SEARCH:-false}" == "true" ]]; then
  while IFS= read -r tenant_id; do
    [[ -z "$tenant_id" ]] && continue
    pnpm --dir "$ROOT_DIR" --filter @knowledge-base/worker search:rebuild -- "$tenant_id"
  done <"$BACKUP_DIR/tenants.txt"
else
  echo "Search projections still require rebuild. Run for every ID in $BACKUP_DIR/tenants.txt:" >&2
  echo "pnpm --filter @knowledge-base/worker search:rebuild -- <tenantId>" >&2
fi

echo "Restore completed from $BACKUP_DIR"
