import type { MigrationInterface, QueryRunner } from 'typeorm';

export class XlsxCellRange1789056000000 implements MigrationInterface {
  name = 'XlsxCellRange1789056000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE document_source_anchor
      ADD COLUMN cell_range varchar(64)
    `);
    await queryRunner.query(`
      ALTER TABLE document_chunk
      ADD COLUMN cell_range varchar(64)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document_chunk DROP COLUMN cell_range');
    await queryRunner.query('ALTER TABLE document_source_anchor DROP COLUMN cell_range');
  }
}
