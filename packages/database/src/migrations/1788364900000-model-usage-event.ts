import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ModelUsageEvent1788364900000 implements MigrationInterface {
  name = 'ModelUsageEvent1788364900000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE model_usage_event (
        id uuid PRIMARY KEY,
        call_id uuid NOT NULL,
        tenant_id uuid,
        user_id uuid,
        run_id uuid,
        source varchar(32),
        operation varchar(16) NOT NULL,
        model varchar(128) NOT NULL,
        attempt integer NOT NULL,
        call_status varchar(16) NOT NULL,
        attempt_status varchar(16) NOT NULL,
        usage_source varchar(16) NOT NULL,
        reserved_tokens integer NOT NULL,
        input_tokens integer NOT NULL,
        output_tokens integer NOT NULL,
        total_tokens integer NOT NULL,
        estimated_cost_usd numeric(20, 10) NOT NULL,
        attempt_duration_ms integer NOT NULL,
        call_duration_ms integer NOT NULL,
        first_token_duration_ms integer,
        error_code varchar(128),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_model_usage_event_call_attempt UNIQUE (call_id, attempt),
        CONSTRAINT model_usage_event_operation_check
          CHECK (operation IN ('embedding', 'chat', 'rerank')),
        CONSTRAINT model_usage_event_call_status_check
          CHECK (call_status IN ('success', 'error', 'cancelled', 'rejected')),
        CONSTRAINT model_usage_event_attempt_status_check
          CHECK (attempt_status IN ('success', 'error', 'cancelled', 'rejected')),
        CONSTRAINT model_usage_event_usage_source_check
          CHECK (usage_source IN ('provider', 'estimated', 'reserved')),
        CONSTRAINT model_usage_event_token_check CHECK (
          reserved_tokens >= 0
          AND input_tokens >= 0
          AND output_tokens >= 0
          AND total_tokens >= 0
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_model_usage_event_tenant_created
      ON model_usage_event (tenant_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_model_usage_event_tenant_operation_model
      ON model_usage_event (tenant_id, operation, model, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_model_usage_event_run
      ON model_usage_event (run_id, created_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE model_usage_event');
  }
}
