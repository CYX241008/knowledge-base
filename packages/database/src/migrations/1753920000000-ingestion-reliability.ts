import type { MigrationInterface, QueryRunner } from 'typeorm';

export class IngestionReliability1753920000000 implements MigrationInterface {
  name = 'IngestionReliability1753920000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document ADD COLUMN purged_at timestamptz');
    await queryRunner.query(`
      ALTER TABLE ingestion_job
        ADD COLUMN generation integer NOT NULL DEFAULT 1,
        ADD COLUMN max_attempts integer NOT NULL DEFAULT 3,
        ADD COLUMN queue_job_id varchar(255),
        ADD COLUMN cancellation_requested_at timestamptz,
        ADD COLUMN dead_lettered_at timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE ingestion_stage
        ADD COLUMN input_checksum char(64),
        ADD COLUMN output_checksum char(64),
        ADD COLUMN run_count integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(
      'ALTER TABLE ingestion_stage DROP CONSTRAINT ingestion_stage_status_check',
    );
    await queryRunner.query(`
      ALTER TABLE ingestion_stage ADD CONSTRAINT ingestion_stage_status_check
      CHECK (status IN ('active', 'completed', 'failed', 'skipped', 'cancelled'))
    `);
    await queryRunner.query(`
      CREATE TABLE outbox_event (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        aggregate_type varchar(64) NOT NULL,
        aggregate_id uuid NOT NULL,
        event_type varchar(128) NOT NULL,
        deduplication_key varchar(255) NOT NULL UNIQUE,
        payload jsonb NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'pending',
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        locked_at timestamptz,
        published_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT outbox_event_status_check
          CHECK (status IN ('pending', 'processing', 'published', 'cancelled', 'dead'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX outbox_event_dispatch_idx ON outbox_event (status, next_attempt_at)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE outbox_event');
    await queryRunner.query(
      'ALTER TABLE ingestion_stage DROP CONSTRAINT ingestion_stage_status_check',
    );
    await queryRunner.query(`
      ALTER TABLE ingestion_stage ADD CONSTRAINT ingestion_stage_status_check
      CHECK (status IN ('active', 'completed', 'failed', 'skipped'))
    `);
    await queryRunner.query(`
      ALTER TABLE ingestion_stage
        DROP COLUMN run_count,
        DROP COLUMN output_checksum,
        DROP COLUMN input_checksum
    `);
    await queryRunner.query(`
      ALTER TABLE ingestion_job
        DROP COLUMN dead_lettered_at,
        DROP COLUMN cancellation_requested_at,
        DROP COLUMN queue_job_id,
        DROP COLUMN max_attempts,
        DROP COLUMN generation
    `);
    await queryRunner.query('ALTER TABLE document DROP COLUMN purged_at');
  }
}
