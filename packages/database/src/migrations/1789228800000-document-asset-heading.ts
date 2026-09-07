import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentAssetHeading1789228800000 implements MigrationInterface {
  name = 'DocumentAssetHeading1789228800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_asset
      ADD COLUMN heading text
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document_asset DROP COLUMN heading');
  }
}
