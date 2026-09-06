import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PdfIntelligence1788796800000 implements MigrationInterface {
  name = 'PdfIntelligence1788796800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_version
      ADD COLUMN quality_status varchar(32),
      ADD COLUMN quality_score integer,
      ADD COLUMN quality_reasons jsonb,
      ADD CONSTRAINT document_version_quality_status_check
        CHECK (quality_status IS NULL OR quality_status IN ('pass', 'review')),
      ADD CONSTRAINT document_version_quality_score_check
        CHECK (quality_score IS NULL OR quality_score BETWEEN 0 AND 100)
    `);
    await queryRunner.query(`
      ALTER TABLE document_chunk
      ADD COLUMN contextual_content text NOT NULL DEFAULT '',
      ADD COLUMN embedding_input_sha256 char(64),
      ADD COLUMN element_type varchar(32),
      ADD COLUMN element_ids varchar(128)[] NOT NULL DEFAULT '{}',
      ADD COLUMN section_path text[] NOT NULL DEFAULT '{}',
      ADD COLUMN table_id varchar(128),
      ADD COLUMN figure_id varchar(128),
      ADD COLUMN bounding_boxes jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN source_confidence real,
      ADD COLUMN context_summary text
    `);
    await queryRunner.query(`
      UPDATE document_chunk
      SET contextual_content = content,
          embedding_input_sha256 = content_sha256
    `);
    await queryRunner.query(`
      ALTER TABLE document_chunk
      ALTER COLUMN embedding_input_sha256 SET NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_chunk
      DROP COLUMN context_summary,
      DROP COLUMN source_confidence,
      DROP COLUMN bounding_boxes,
      DROP COLUMN figure_id,
      DROP COLUMN table_id,
      DROP COLUMN section_path,
      DROP COLUMN element_ids,
      DROP COLUMN element_type,
      DROP COLUMN embedding_input_sha256,
      DROP COLUMN contextual_content
    `);
    await queryRunner.query(`
      ALTER TABLE document_version
      DROP CONSTRAINT document_version_quality_score_check,
      DROP CONSTRAINT document_version_quality_status_check,
      DROP COLUMN quality_reasons,
      DROP COLUMN quality_score,
      DROP COLUMN quality_status
    `);
  }
}
