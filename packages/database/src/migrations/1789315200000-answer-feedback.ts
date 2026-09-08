import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AnswerFeedback1789315200000 implements MigrationInterface {
  name = 'AnswerFeedback1789315200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE answer_run
      ADD CONSTRAINT uq_answer_run_id_tenant UNIQUE (id, tenant_id)
    `);
    await queryRunner.query(`
      CREATE TABLE answer_feedback (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        answer_run_id uuid NOT NULL,
        user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        rating varchar(16) NOT NULL,
        reason varchar(32),
        comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_answer_feedback_run_tenant
          FOREIGN KEY (answer_run_id, tenant_id)
          REFERENCES answer_run(id, tenant_id)
          ON DELETE CASCADE,
        CONSTRAINT answer_feedback_rating_check
          CHECK (rating IN ('helpful', 'unhelpful')),
        CONSTRAINT answer_feedback_reason_check CHECK (
          reason IS NULL OR reason IN (
            'answer_incorrect',
            'citation_incorrect',
            'incomplete',
            'outdated',
            'hallucinated',
            'should_have_refused',
            'other'
          )
        ),
        CONSTRAINT answer_feedback_comment_length_check
          CHECK (comment IS NULL OR char_length(comment) <= 1000),
        CONSTRAINT answer_feedback_reason_required_check CHECK (
          (rating = 'helpful' AND reason IS NULL)
          OR
          (rating = 'unhelpful' AND reason IS NOT NULL)
        ),
        CONSTRAINT uq_answer_feedback_run_user
          UNIQUE (tenant_id, answer_run_id, user_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_answer_feedback_tenant_created
      ON answer_feedback (tenant_id, created_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_answer_feedback_tenant_rating
      ON answer_feedback (tenant_id, rating, created_at DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE answer_feedback');
    await queryRunner.query('ALTER TABLE answer_run DROP CONSTRAINT uq_answer_run_id_tenant');
  }
}
