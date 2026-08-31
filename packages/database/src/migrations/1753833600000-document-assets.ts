import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentAssets1753833600000 implements MigrationInterface {
  name = 'DocumentAssets1753833600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document_asset (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_version_id uuid NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
        kind varchar(32) NOT NULL,
        filename varchar(1024) NOT NULL,
        object_key text NOT NULL,
        mime_type varchar(255) NOT NULL,
        size_bytes bigint NOT NULL,
        sha256 char(64) NOT NULL,
        page_no integer,
        ordinal integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT document_asset_version_object_unique UNIQUE (document_version_id, object_key)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX document_asset_version_idx ON document_asset (tenant_id, document_version_id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE document_asset');
  }
}
