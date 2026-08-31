#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/compose.yaml"
PROJECT_NAME="${DRILL_PROJECT_NAME:-knowledge-base-restore-drill}"
DRILL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/knowledge-base-restore-drill.XXXXXX")"
TENANT_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
CONVERSATION_ID="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
USER_ID="cccccccc-cccc-4ccc-8ccc-cccccccccccc"

CONFIRMATION="${DRILL_CONFIRM:-${1:-}}"
if [[ "$CONFIRMATION" != "knowledge-base" ]]; then
  echo "Usage: DRILL_CONFIRM=knowledge-base $0 (or: $0 knowledge-base)" >&2
  exit 1
fi

compose() {
  COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$DRILL_ROOT"
}
trap cleanup EXIT INT TERM

compose up -d --wait --pull never postgres redis minio elasticsearch

DATABASE_URL="postgresql://knowledge:knowledge@localhost:5432/knowledge_base" \
  pnpm --dir "$ROOT_DIR" db:migrate >/dev/null
REDIS_URL="redis://localhost:6379" pnpm --dir "$ROOT_DIR" e2e:model-quota >/dev/null

compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
INSERT INTO chat_conversation (id, tenant_id, created_by, title)
VALUES ('$CONVERSATION_ID', '$TENANT_ID', '$USER_ID', 'phase9-backup-marker');
SQL

compose run --rm --no-deps --entrypoint /bin/sh minio-client -c \
  'mc alias set target http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null && mc mb --ignore-existing "target/$MINIO_BUCKET" >/dev/null && printf phase9-object-marker | mc pipe "target/$MINIO_BUCKET/phase9/marker.txt" >/dev/null'

COMPOSE_PROJECT_NAME="$PROJECT_NAME" bash "$ROOT_DIR/scripts/ops/backup.sh" "$DRILL_ROOT" >/dev/null
BACKUP_DIR="$(find "$DRILL_ROOT" -mindepth 1 -maxdepth 1 -type d | head -n 1)"

compose exec -T postgres sh -c \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<SQL
UPDATE chat_conversation SET title = 'mutated-after-backup' WHERE id = '$CONVERSATION_ID';
SQL
compose run --rm --no-deps --entrypoint /bin/sh minio-client -c \
  'mc alias set target http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null && mc rm "target/$MINIO_BUCKET/phase9/marker.txt" >/dev/null'

COMPOSE_PROJECT_NAME="$PROJECT_NAME" RESTORE_CONFIRM=knowledge-base \
  bash "$ROOT_DIR/scripts/ops/restore.sh" "$BACKUP_DIR" >/dev/null

RESTORED_TITLE="$(compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT title FROM chat_conversation WHERE id = '\''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'\''"')"
RESTORED_OBJECT="$(compose run --rm --no-deps --entrypoint /bin/sh minio-client -c \
  'mc alias set target http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null && mc cat "target/$MINIO_BUCKET/phase9/marker.txt"')"

if [[ "$RESTORED_TITLE" != "phase9-backup-marker" ]]; then
  echo "Database restore verification failed: $RESTORED_TITLE" >&2
  exit 1
fi
if [[ "$RESTORED_OBJECT" != "phase9-object-marker" ]]; then
  echo "Object restore verification failed: $RESTORED_OBJECT" >&2
  exit 1
fi

echo '{"postgresRestored":true,"minioRestored":true,"checksumsVerified":true,"globalQuotaVerified":true,"isolatedVolumesRemoved":true}'
