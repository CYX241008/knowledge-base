import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentAssetLocation1789142400000 implements MigrationInterface {
  name = 'DocumentAssetLocation1789142400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_asset
      ADD COLUMN slide_no integer,
      ADD COLUMN sheet_name varchar(255),
      ADD COLUMN row_start integer,
      ADD COLUMN row_end integer,
      ADD COLUMN cell_range varchar(64)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_asset
      DROP COLUMN cell_range,
      DROP COLUMN row_end,
      DROP COLUMN row_start,
      DROP COLUMN sheet_name,
      DROP COLUMN slide_no
    `);
  }
}
