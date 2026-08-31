import type { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialDocuments1753747200000 implements MigrationInterface {
  name = 'InitialDocuments1753747200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE document (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        space_id uuid,
        folder_id uuid,
        title varchar(500) NOT NULL,
        summary text,
        status varchar(32) NOT NULL DEFAULT 'draft',
        current_ready_version_id uuid,
        created_by uuid,
        updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        deleted_at timestamptz,
        CONSTRAINT document_status_check CHECK (status IN ('draft', 'published', 'archived'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX document_tenant_created_idx ON document (tenant_id, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE document_version (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_id uuid NOT NULL REFERENCES document(id),
        version_no integer NOT NULL,
        source_bucket varchar(255) NOT NULL,
        source_object_key text NOT NULL,
        source_filename varchar(1024) NOT NULL,
        mime_type varchar(255) NOT NULL,
        size_bytes bigint NOT NULL,
        sha256 char(64) NOT NULL,
        markdown_bucket varchar(255),
        markdown_object_key text,
        parser_name varchar(128),
        parser_version varchar(64),
        ingestion_status varchar(32) NOT NULL DEFAULT 'received',
        word_count integer NOT NULL DEFAULT 0,
        error_code varchar(128),
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        ready_at timestamptz,
        CONSTRAINT document_version_unique UNIQUE (tenant_id, document_id, version_no),
        CONSTRAINT document_version_status_check CHECK (
          ingestion_status IN ('received', 'stored', 'parsing', 'normalizing', 'chunking', 'indexing', 'ready', 'retrying', 'failed', 'cancelled')
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX document_version_tenant_status_idx ON document_version (tenant_id, ingestion_status)',
    );

    await queryRunner.query(`
      CREATE TABLE document_source_anchor (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_version_id uuid NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
        anchor_type varchar(32) NOT NULL,
        page_no integer,
        slide_no integer,
        sheet_name varchar(255),
        row_start integer,
        row_end integer,
        heading text,
        markdown_offset_start integer NOT NULL,
        markdown_offset_end integer NOT NULL
      )
    `);
    await queryRunner.query(
      'CREATE INDEX document_source_anchor_version_idx ON document_source_anchor (tenant_id, document_version_id)',
    );

    await queryRunner.query(`
      CREATE TABLE ingestion_job (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        document_id uuid NOT NULL REFERENCES document(id),
        document_version_id uuid NOT NULL UNIQUE REFERENCES document_version(id),
        status varchar(32) NOT NULL DEFAULT 'queued',
        progress integer NOT NULL DEFAULT 0,
        attempts integer NOT NULL DEFAULT 0,
        error_message text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT ingestion_job_status_check CHECK (status IN ('queued', 'active', 'completed', 'failed', 'cancelled')),
        CONSTRAINT ingestion_job_progress_check CHECK (progress BETWEEN 0 AND 100)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX ingestion_job_tenant_created_idx ON ingestion_job (tenant_id, created_at DESC)',
    );

    await queryRunner.query(`
      CREATE TABLE ingestion_stage (
        id uuid PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES ingestion_job(id) ON DELETE CASCADE,
        stage varchar(32) NOT NULL,
        status varchar(32) NOT NULL,
        progress integer NOT NULL DEFAULT 0,
        processor_version varchar(64),
        error_message text,
        started_at timestamptz NOT NULL DEFAULT now(),
        completed_at timestamptz,
        CONSTRAINT ingestion_stage_unique UNIQUE (job_id, stage),
        CONSTRAINT ingestion_stage_status_check CHECK (status IN ('active', 'completed', 'failed', 'skipped')),
        CONSTRAINT ingestion_stage_progress_check CHECK (progress BETWEEN 0 AND 100)
      )
    `);

    await queryRunner.query(
      'ALTER TABLE document ADD CONSTRAINT document_current_version_fk FOREIGN KEY (current_ready_version_id) REFERENCES document_version(id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document DROP CONSTRAINT document_current_version_fk');
    await queryRunner.query('DROP TABLE ingestion_stage');
    await queryRunner.query('DROP TABLE ingestion_job');
    await queryRunner.query('DROP TABLE document_source_anchor');
    await queryRunner.query('DROP TABLE document_version');
    await queryRunner.query('DROP TABLE document');
  }
}
