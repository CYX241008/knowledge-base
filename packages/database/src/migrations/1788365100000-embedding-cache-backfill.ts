import type { MigrationInterface, QueryRunner } from 'typeorm';

export class EmbeddingCacheBackfill1788365100000 implements MigrationInterface {
  name = 'EmbeddingCacheBackfill1788365100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO embedding_cache (
        tenant_id,
        content_sha256,
        embedding_model,
        dimensions,
        embedding,
        token_count
      )
      SELECT DISTINCT ON (tenant_id, content_sha256, embedding_model)
             tenant_id,
             content_sha256,
             embedding_model,
             384,
             embedding,
             token_count
      FROM document_chunk
      ORDER BY tenant_id, content_sha256, embedding_model, created_at DESC
      ON CONFLICT DO NOTHING
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_document_chunk_tenant_model_version
      ON document_chunk (tenant_id, embedding_model, document_version_id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS idx_document_chunk_tenant_model_version');
  }
}
