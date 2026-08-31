import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SystemGovernance1754438400000 implements MigrationInterface {
  name = 'SystemGovernance1754438400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO access_permission (key, name, description)
      VALUES ('system.manage', '系统设置管理', '管理租户运行设置、审计策略与质量成本治理')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_key)
      SELECT id, 'system.manage'
      FROM access_role
      WHERE is_system = true
      ON CONFLICT (role_id, permission_key) DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE tenant_system_setting (
        tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
        search_candidate_limit integer NOT NULL DEFAULT 200,
        search_score_threshold double precision NOT NULL DEFAULT 0,
        search_page_size integer NOT NULL DEFAULT 10,
        feedback_enabled boolean NOT NULL DEFAULT true,
        audit_retention_days integer NOT NULL DEFAULT 365,
        version integer NOT NULL DEFAULT 1,
        updated_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenant_system_setting_candidate_limit_check
          CHECK (search_candidate_limit BETWEEN 50 AND 500),
        CONSTRAINT tenant_system_setting_score_threshold_check
          CHECK (search_score_threshold BETWEEN 0 AND 1),
        CONSTRAINT tenant_system_setting_page_size_check
          CHECK (search_page_size BETWEEN 5 AND 50),
        CONSTRAINT tenant_system_setting_audit_retention_check
          CHECK (audit_retention_days BETWEEN 30 AND 3650),
        CONSTRAINT tenant_system_setting_version_check CHECK (version > 0)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE search_feedback (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        query_event_id uuid NOT NULL REFERENCES search_query_event(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        rating varchar(16) NOT NULL,
        reason varchar(32),
        comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT search_feedback_rating_check CHECK (rating IN ('helpful', 'unhelpful')),
        CONSTRAINT search_feedback_reason_check CHECK (
          reason IS NULL OR reason IN ('irrelevant', 'incomplete', 'outdated', 'incorrect', 'other')
        ),
        CONSTRAINT search_feedback_comment_length_check
          CHECK (comment IS NULL OR char_length(comment) <= 1000),
        CONSTRAINT uq_search_feedback_query_user UNIQUE (tenant_id, query_event_id, user_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_search_feedback_tenant_created ON search_feedback (tenant_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_search_feedback_tenant_rating ON search_feedback (tenant_id, rating, created_at DESC)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE search_feedback');
    await queryRunner.query('DROP TABLE tenant_system_setting');
    await queryRunner.query("DELETE FROM role_permission WHERE permission_key = 'system.manage'");
    await queryRunner.query("DELETE FROM access_permission WHERE key = 'system.manage'");
  }
}
