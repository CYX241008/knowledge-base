# Local Infrastructure

`pnpm infra:up` starts PostgreSQL with pgvector, Redis, MinIO and Elasticsearch.

The Compose project name is pinned in `compose.yaml` so commands run from different
directories reuse the same local infrastructure instead of creating duplicate
project groups. Use `pnpm infra:up` and `pnpm infra:down` for normal operation;
reserve `-p` or `COMPOSE_PROJECT_NAME` overrides for explicitly isolated drills.

Neo4j is intentionally optional during the MVP. Start it only when graph extraction and multi-hop retrieval are implemented:

```bash
docker compose -f infra/compose/compose.yaml --profile extended up -d
```

The MinIO and Elastic images are suitable for local development. Pin and scan image digests before production deployment.
