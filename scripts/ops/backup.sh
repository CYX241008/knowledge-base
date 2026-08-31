#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT_DIR/infra/compose/compose.yaml"
BACKUP_ROOT="${1:-$ROOT_DIR/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DESTINATION="$BACKUP_ROOT/$STAMP"

mkdir -p "$DESTINATION/minio"
touch "$DESTINATION/.incomplete"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

RUNNING_SERVICES="$(compose ps --status running --services)"
for required_service in postgres minio; do
  if ! grep -qx "$required_service" <<<"$RUNNING_SERVICES"; then
    echo "$required_service must be running before backup" >&2
    exit 1
  fi
done

compose exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  >"$DESTINATION/postgres.dump"

compose exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT tenant_id FROM (SELECT tenant_id FROM document UNION SELECT tenant_id FROM ingestion_job UNION SELECT tenant_id FROM chat_conversation) facts ORDER BY tenant_id"' \
  >"$DESTINATION/tenants.txt"

compose run --rm --no-deps \
  -v "$DESTINATION/minio:/backup" \
  --entrypoint /bin/sh minio-client -c \
  'mc alias set source http://minio:9000 "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null && mc mirror --overwrite "source/$MINIO_BUCKET" /backup >/dev/null'

OBJECT_COUNT="$(find "$DESTINATION/minio" -type f | wc -l | tr -d ' ')"
DATABASE_BYTES="$(wc -c <"$DESTINATION/postgres.dump" | tr -d ' ')"
cat >"$DESTINATION/manifest.json" <<EOF
{
  "formatVersion": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "postgresFormat": "custom",
  "databaseBytes": $DATABASE_BYTES,
  "minioObjectCount": $OBJECT_COUNT,
  "searchProjection": "rebuild-required",
  "redis": "ephemeral-reconciliation-required"
}
EOF

(
  cd "$DESTINATION"
  shasum -a 256 postgres.dump tenants.txt manifest.json
  find minio -type f -exec shasum -a 256 {} +
) >"$DESTINATION/SHA256SUMS"

rm "$DESTINATION/.incomplete"
echo "$DESTINATION"
