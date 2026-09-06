import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ModelBudgetGovernance1788624000000 implements MigrationInterface {
  name = 'ModelBudgetGovernance1788624000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE tenant_system_setting
      ADD COLUMN model_daily_budget_usd numeric(20, 6) NOT NULL DEFAULT 0,
      ADD COLUMN model_monthly_budget_usd numeric(20, 6) NOT NULL DEFAULT 0,
      ADD COLUMN model_budget_action varchar(16) NOT NULL DEFAULT 'warn',
      ADD CONSTRAINT tenant_system_setting_budget_action_check
        CHECK (model_budget_action IN ('warn', 'degrade', 'reject')),
      ADD CONSTRAINT tenant_system_setting_budget_values_check
        CHECK (model_daily_budget_usd >= 0 AND model_monthly_budget_usd >= 0)
    `);
    await queryRunner.query(`
      ALTER TABLE model_usage_event
      ADD COLUMN input_cost_per_million_tokens numeric(20, 10) NOT NULL DEFAULT 0,
      ADD COLUMN output_cost_per_million_tokens numeric(20, 10) NOT NULL DEFAULT 0,
      ADD COLUMN pricing_source varchar(255) NOT NULL DEFAULT 'legacy'
    `);
    await queryRunner.query(`
      ALTER TABLE answer_run
      ADD COLUMN requested_model varchar(128),
      ADD COLUMN actual_model varchar(128),
      ADD COLUMN degraded boolean NOT NULL DEFAULT false,
      ADD COLUMN degradation_reason varchar(128),
      ADD COLUMN estimated_cost_usd numeric(20, 10) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      CREATE TABLE model_budget_alert (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        period_type varchar(16) NOT NULL,
        period_start timestamptz NOT NULL,
        threshold_percent integer NOT NULL,
        usage_cost_usd numeric(20, 10) NOT NULL,
        budget_usd numeric(20, 6) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT model_budget_alert_period_check CHECK (period_type IN ('day', 'month')),
        CONSTRAINT model_budget_alert_threshold_check
          CHECK (threshold_percent > 0 AND threshold_percent <= 100),
        CONSTRAINT model_budget_alert_values_check
          CHECK (usage_cost_usd >= 0 AND budget_usd >= 0),
        CONSTRAINT uq_model_budget_alert_period_threshold
          UNIQUE (tenant_id, period_type, period_start, threshold_percent)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_model_budget_alert_tenant_created
      ON model_budget_alert (tenant_id, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE model_budget_alert');
    await queryRunner.query(`
      ALTER TABLE answer_run
      DROP COLUMN estimated_cost_usd,
      DROP COLUMN degradation_reason,
      DROP COLUMN degraded,
      DROP COLUMN actual_model,
      DROP COLUMN requested_model
    `);
    await queryRunner.query(`
      ALTER TABLE model_usage_event
      DROP COLUMN pricing_source,
      DROP COLUMN output_cost_per_million_tokens,
      DROP COLUMN input_cost_per_million_tokens
    `);
    await queryRunner.query(`
      ALTER TABLE tenant_system_setting
      DROP CONSTRAINT tenant_system_setting_budget_values_check,
      DROP CONSTRAINT tenant_system_setting_budget_action_check,
      DROP COLUMN model_budget_action,
      DROP COLUMN model_monthly_budget_usd,
      DROP COLUMN model_daily_budget_usd
    `);
  }
}
