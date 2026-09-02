import type { MigrationInterface, QueryRunner } from 'typeorm';

export class DocumentReview1754524800000 implements MigrationInterface {
  name = 'DocumentReview1754524800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO access_permission (key, name, description)
      VALUES ('documents.review', '审核文档版本', '查看审核待办并批准或驳回待发布文档版本')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO role_permission (role_id, permission_key)
      SELECT id, 'documents.review'
      FROM access_role
      WHERE is_system = true
      ON CONFLICT (role_id, permission_key) DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE document_review_request (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
        document_version_id uuid NOT NULL REFERENCES document_version(id) ON DELETE CASCADE,
        status varchar(32) NOT NULL DEFAULT 'pending',
        submitted_by uuid NOT NULL REFERENCES app_user(id),
        submitted_at timestamptz NOT NULL DEFAULT now(),
        resolved_by uuid REFERENCES app_user(id),
        resolved_at timestamptz,
        decision_comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT document_review_request_status_check
          CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
        CONSTRAINT document_review_request_resolution_check CHECK (
          (status = 'pending' AND resolved_by IS NULL AND resolved_at IS NULL)
          OR
          (status <> 'pending' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_document_review_request_pending_document
      ON document_review_request (tenant_id, document_id)
      WHERE status = 'pending'
    `);
    await queryRunner.query(`
      CREATE INDEX idx_document_review_request_tenant_status
      ON document_review_request (tenant_id, status, submitted_at DESC)
    `);
    await queryRunner.query(`
      CREATE INDEX idx_document_review_request_document
      ON document_review_request (tenant_id, document_id, submitted_at DESC)
    `);
    await queryRunner.query(`
      CREATE TABLE document_review_action (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        review_request_id uuid NOT NULL REFERENCES document_review_request(id) ON DELETE CASCADE,
        action varchar(32) NOT NULL,
        actor_id uuid NOT NULL REFERENCES app_user(id),
        comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT document_review_action_type_check
          CHECK (action IN ('submitted', 'approved', 'rejected', 'withdrawn'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_document_review_action_request
      ON document_review_action (review_request_id, created_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE document_review_action');
    await queryRunner.query('DROP TABLE document_review_request');
    await queryRunner.query(
      "DELETE FROM role_permission WHERE permission_key = 'documents.review'",
    );
    await queryRunner.query("DELETE FROM access_permission WHERE key = 'documents.review'");
  }
}
