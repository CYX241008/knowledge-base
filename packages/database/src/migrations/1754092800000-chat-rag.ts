import type { MigrationInterface, QueryRunner } from 'typeorm';

export class ChatRag1754092800000 implements MigrationInterface {
  name = 'ChatRag1754092800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chat_conversation (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        created_by uuid NOT NULL,
        title varchar(255) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_chat_conversation_owner ON chat_conversation (tenant_id, created_by, updated_at DESC)',
    );
    await queryRunner.query(`
      CREATE TABLE chat_message (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        conversation_id uuid NOT NULL,
        role varchar(16) NOT NULL CHECK (role IN ('user', 'assistant')),
        content text NOT NULL,
        model varchar(128),
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT fk_chat_message_conversation
          FOREIGN KEY (conversation_id) REFERENCES chat_conversation(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_chat_message_conversation ON chat_message (tenant_id, conversation_id, created_at)',
    );
    await queryRunner.query(`
      CREATE TABLE chat_citation (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        message_id uuid NOT NULL,
        ordinal integer NOT NULL,
        chunk_id uuid NOT NULL,
        document_id uuid NOT NULL,
        document_version_id uuid NOT NULL,
        document_title varchar(500) NOT NULL,
        excerpt text NOT NULL,
        source jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_chat_citation_message_ordinal UNIQUE (message_id, ordinal),
        CONSTRAINT fk_chat_citation_message
          FOREIGN KEY (message_id) REFERENCES chat_message(id) ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_chat_citation_message ON chat_citation (tenant_id, message_id)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_chat_citation_document ON chat_citation (tenant_id, document_id)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE chat_citation');
    await queryRunner.query('DROP TABLE chat_message');
    await queryRunner.query('DROP TABLE chat_conversation');
  }
}
