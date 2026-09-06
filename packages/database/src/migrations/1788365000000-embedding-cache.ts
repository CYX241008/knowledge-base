import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EmbeddingCache1788365000000 implements MigrationInterface {
  name = 'EmbeddingCache1788365000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE embedding_cache (
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        content_sha256 char(64) NOT NULL,
        embedding_model varchar(128) NOT NULL,
        dimensions integer NOT NULL,
        embedding vector(384) NOT NULL,
        token_count integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, content_sha256, embedding_model, dimensions),
        CONSTRAINT embedding_cache_dimensions_check CHECK (dimensions = 384),
        CONSTRAINT embedding_cache_token_count_check CHECK (token_count >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_embedding_cache_tenant_model_updated
      ON embedding_cache (tenant_id, embedding_model, updated_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE embedding_cache');
  }
}
