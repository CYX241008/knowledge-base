import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentProcessingLocation1788969600000 implements MigrationInterface {
  name = 'DocumentProcessingLocation1788969600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_processing_metric
      ADD COLUMN document_format varchar(32),
      ADD COLUMN location_type varchar(32),
      ADD COLUMN location jsonb
    `);
    await queryRunner.query(`
      UPDATE document_processing_metric
      SET document_format = 'pdf',
          location_type = 'page',
          location = jsonb_build_object('type', 'page', 'page', page_no)
    `);
    await queryRunner.query(`
      ALTER TABLE document_processing_metric
      ALTER COLUMN document_format SET NOT NULL,
      ALTER COLUMN location_type SET NOT NULL,
      ALTER COLUMN location SET NOT NULL,
      ALTER COLUMN page_no DROP NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE document_processing_metric
      ADD CONSTRAINT document_processing_metric_format_check
        CHECK (document_format IN ('pdf', 'markdown', 'text', 'docx', 'pptx', 'xlsx')),
      ADD CONSTRAINT document_processing_metric_location_type_check
        CHECK (location_type IN ('document', 'section', 'page', 'slide', 'sheet'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE document_processing_metric
      SET page_no = 1
      WHERE page_no IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE document_processing_metric
      ALTER COLUMN page_no SET NOT NULL,
      DROP CONSTRAINT document_processing_metric_location_type_check,
      DROP CONSTRAINT document_processing_metric_format_check,
      DROP COLUMN location,
      DROP COLUMN location_type,
      DROP COLUMN document_format
    `);
  }
}
