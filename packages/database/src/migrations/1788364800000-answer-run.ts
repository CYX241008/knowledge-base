import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AnswerRun1788364800000 implements MigrationInterface {
  name = 'AnswerRun1788364800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE answer_run (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        conversation_id uuid NOT NULL,
        user_message_id uuid NOT NULL,
        assistant_message_id uuid,
        status varchar(16) NOT NULL DEFAULT 'running',
        error_code varchar(128),
        started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at timestamptz,
        CONSTRAINT uq_answer_run_user_message UNIQUE (user_message_id),
        CONSTRAINT uq_answer_run_assistant_message UNIQUE (assistant_message_id),
        CONSTRAINT answer_run_status_check
          CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        CONSTRAINT answer_run_lifecycle_check CHECK (
          (
            status = 'running'
            AND assistant_message_id IS NULL
            AND error_code IS NULL
            AND completed_at IS NULL
          )
          OR
          (
            status = 'completed'
            AND assistant_message_id IS NOT NULL
            AND error_code IS NULL
            AND completed_at IS NOT NULL
          )
          OR
          (
            status IN ('failed', 'cancelled')
            AND assistant_message_id IS NULL
            AND completed_at IS NOT NULL
          )
        ),
        CONSTRAINT fk_answer_run_conversation
          FOREIGN KEY (conversation_id) REFERENCES chat_conversation(id) ON DELETE CASCADE,
        CONSTRAINT fk_answer_run_user_message
          FOREIGN KEY (user_message_id) REFERENCES chat_message(id) ON DELETE CASCADE,
        CONSTRAINT fk_answer_run_assistant_message
          FOREIGN KEY (assistant_message_id) REFERENCES chat_message(id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_answer_run_conversation
      ON answer_run (tenant_id, conversation_id, started_at)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_answer_run_status
      ON answer_run (tenant_id, status, started_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE answer_run');
  }
}
