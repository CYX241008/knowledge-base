import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PdfStructure1788710400000 implements MigrationInterface {
  name = 'PdfStructure1788710400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_version
      ADD COLUMN structure_bucket varchar(255),
      ADD COLUMN structure_object_key text,
      ADD COLUMN structure_sha256 char(64)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_version
      DROP COLUMN structure_sha256,
      DROP COLUMN structure_object_key,
      DROP COLUMN structure_bucket
    `);
  }
}
