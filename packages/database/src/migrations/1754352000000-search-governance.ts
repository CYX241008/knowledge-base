import type { MigrationInterface, QueryRunner } from 'typeorm';

export class SearchGovernance1754352000000 implements MigrationInterface {
  name = 'SearchGovernance1754352000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE search_query_event (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        user_id uuid,
        source varchar(16) NOT NULL,
        query_text varchar(2000) NOT NULL,
        filters jsonb NOT NULL DEFAULT '{}'::jsonb,
        result_count integer NOT NULL DEFAULT 0,
        duration_ms integer NOT NULL DEFAULT 0,
        vector_candidate_count integer NOT NULL DEFAULT 0,
        keyword_candidate_count integer NOT NULL DEFAULT 0,
        status varchar(16) NOT NULL,
        error_code varchar(128),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT search_query_event_source_check CHECK (source IN ('search', 'answer')),
        CONSTRAINT search_query_event_status_check CHECK (status IN ('success', 'failed')),
        CONSTRAINT search_query_event_nonnegative_check CHECK (
          result_count >= 0 AND duration_ms >= 0
          AND vector_candidate_count >= 0 AND keyword_candidate_count >= 0
        )
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_search_query_event_tenant_created ON search_query_event (tenant_id, created_at DESC)',
    );
    await queryRunner.query(
      "CREATE INDEX idx_search_query_event_zero_results ON search_query_event (tenant_id, created_at DESC) WHERE status = 'success' AND result_count = 0",
    );
    await queryRunner.query(
      'CREATE INDEX idx_search_query_event_query_ci ON search_query_event (tenant_id, lower(query_text), created_at DESC)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE search_query_event');
  }
}
