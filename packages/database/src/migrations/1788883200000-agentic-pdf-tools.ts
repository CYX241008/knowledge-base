import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AgenticPdfTools1788883200000 implements MigrationInterface {
  name = 'AgenticPdfTools1788883200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_run
      ADD COLUMN tool_trace jsonb NOT NULL DEFAULT '[]'::jsonb
    `);
    await queryRunner.query(`
      ALTER TABLE model_usage_event
      ADD COLUMN document_version_id uuid,
      ADD COLUMN page_no integer,
      ADD COLUMN asset_id varchar(128),
      ADD COLUMN tool_name varchar(64)
    `);
    await queryRunner.query(`
      CREATE TABLE document_processing_metric (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_version_id uuid NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
        page_no integer NOT NULL,
        operation varchar(32) NOT NULL,
        provider varchar(64) NOT NULL,
        model varchar(128),
        status varchar(16) NOT NULL,
        duration_ms integer NOT NULL,
        cache_hit boolean NOT NULL DEFAULT false,
        asset_id varchar(128),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT document_processing_metric_operation_check CHECK (operation IN ('ocr', 'vision')),
        CONSTRAINT document_processing_metric_status_check CHECK (status IN ('success', 'failed', 'skipped'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_document_processing_metric_version
      ON document_processing_metric (tenant_id, document_version_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE document_processing_metric');
    await queryRunner.query(`
      ALTER TABLE model_usage_event
      DROP COLUMN tool_name,
      DROP COLUMN asset_id,
      DROP COLUMN page_no,
      DROP COLUMN document_version_id
    `);
    await queryRunner.query('ALTER TABLE answer_run DROP COLUMN tool_trace');
  }
}
