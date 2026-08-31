import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentSearch1754006400000 implements MigrationInterface {
  name = 'DocumentSearch1754006400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector');
    await queryRunner.query(`
      ALTER TABLE document
      ADD COLUMN access_principal_ids varchar(128)[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      UPDATE document
      SET access_principal_ids = ARRAY['tenant:' || tenant_id::text]
      WHERE cardinality(access_principal_ids) = 0
    `);
    await queryRunner.query(`
      CREATE TABLE document_chunk (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_id uuid NOT NULL,
        document_version_id uuid NOT NULL,
        ordinal integer NOT NULL,
        content text NOT NULL,
        content_sha256 char(64) NOT NULL,
        token_count integer NOT NULL,
        anchor_type varchar(32) NOT NULL,
        page_no integer,
        slide_no integer,
        sheet_name varchar(255),
        row_start integer,
        row_end integer,
        heading text,
        markdown_offset_start integer NOT NULL,
        markdown_offset_end integer NOT NULL,
        principal_ids varchar(128)[] NOT NULL,
        embedding vector(384) NOT NULL,
        embedding_model varchar(128) NOT NULL,
        chunker_version varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_document_chunk_version_ordinal UNIQUE (document_version_id, ordinal),
        CONSTRAINT fk_document_chunk_document FOREIGN KEY (document_id) REFERENCES document(id),
        CONSTRAINT fk_document_chunk_version FOREIGN KEY (document_version_id) REFERENCES document_version(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_document_chunk_tenant_version ON document_chunk (tenant_id, document_version_id)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_document_chunk_principals ON document_chunk USING gin (principal_ids)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_document_chunk_embedding_hnsw ON document_chunk USING hnsw (embedding vector_cosine_ops)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE document_chunk');
    await queryRunner.query('ALTER TABLE document DROP COLUMN access_principal_ids');
  }
}
