import type { MigrationInterface, QueryRunner } from 'typeorm';

export class KnowledgeOrganization1754265600000 implements MigrationInterface {
  name = 'KnowledgeOrganization1754265600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO access_permission (key, name, description)
      VALUES ('knowledge.manage', '知识组织管理', '管理知识空间、文件夹、标签及文档归档位置')
      ON CONFLICT (key) DO NOTHING
    `);
    await queryRunner.query(`
      CREATE TABLE knowledge_space (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        name varchar(255) NOT NULL,
        description text,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_knowledge_space_tenant_id UNIQUE (tenant_id, id)
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_space_tenant_name_ci ON knowledge_space (tenant_id, lower(name))',
    );
    await queryRunner.query(`
      CREATE TABLE knowledge_folder (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        space_id uuid NOT NULL,
        parent_id uuid,
        name varchar(255) NOT NULL,
        description text,
        sort_order integer NOT NULL DEFAULT 0,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fk_knowledge_folder_space
          FOREIGN KEY (tenant_id, space_id) REFERENCES knowledge_space(tenant_id, id) ON DELETE CASCADE,
        CONSTRAINT fk_knowledge_folder_parent FOREIGN KEY (parent_id) REFERENCES knowledge_folder(id),
        CONSTRAINT uq_knowledge_folder_tenant_space_id UNIQUE (tenant_id, space_id, id),
        CONSTRAINT knowledge_folder_not_self CHECK (parent_id IS NULL OR parent_id <> id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_knowledge_folder_parent ON knowledge_folder (tenant_id, space_id, parent_id, sort_order)',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_folder_root_name_ci ON knowledge_folder (tenant_id, space_id, lower(name)) WHERE parent_id IS NULL',
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_folder_child_name_ci ON knowledge_folder (tenant_id, space_id, parent_id, lower(name)) WHERE parent_id IS NOT NULL',
    );
    await queryRunner.query(`
      CREATE TABLE knowledge_tag (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        color char(7) NOT NULL,
        description text,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT knowledge_tag_color_check CHECK (color ~ '^#[0-9a-fA-F]{6}$')
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_tag_tenant_name_ci ON knowledge_tag (tenant_id, lower(name))',
    );
    await queryRunner.query(`
      CREATE TABLE document_tag (
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
        tag_id uuid NOT NULL REFERENCES knowledge_tag(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (document_id, tag_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_document_tag_tenant_tag ON document_tag (tenant_id, tag_id)',
    );
    await queryRunner.query(`
      CREATE TABLE audit_event (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        actor_id uuid,
        action varchar(128) NOT NULL,
        resource_type varchar(64) NOT NULL,
        resource_id uuid,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_audit_event_tenant_created ON audit_event (tenant_id, created_at DESC)',
    );
    await queryRunner.query(
      'CREATE INDEX idx_audit_event_resource ON audit_event (tenant_id, resource_type, resource_id)',
    );
    await queryRunner.query(
      'ALTER TABLE document ADD COLUMN search_projection_version integer NOT NULL DEFAULT 1',
    );
    await queryRunner.query(
      'ALTER TABLE resource_acl DROP CONSTRAINT resource_acl_resource_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE resource_acl ADD CONSTRAINT resource_acl_resource_type_check CHECK (resource_type IN ('document', 'space', 'folder'))",
    );
    await queryRunner.query(
      'ALTER TABLE document_effective_principal DROP CONSTRAINT document_effective_source_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE document_effective_principal ADD CONSTRAINT document_effective_source_type_check CHECK (source_resource_type IN ('document', 'space', 'folder'))",
    );

    await queryRunner.query(`
      INSERT INTO knowledge_space (id, tenant_id, name, description)
      SELECT DISTINCT ON (space_id) space_id, tenant_id,
             'Recovered ' || left(space_id::text, 8), 'Recovered from existing document metadata'
      FROM document
      WHERE space_id IS NOT NULL
      ORDER BY space_id, created_at
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(
      'UPDATE document SET folder_id = NULL WHERE folder_id IS NOT NULL AND space_id IS NULL',
    );
    await queryRunner.query(`
      INSERT INTO knowledge_folder (id, tenant_id, space_id, name, description)
      SELECT DISTINCT ON (folder_id) folder_id, tenant_id, space_id,
             'Recovered ' || left(folder_id::text, 8), 'Recovered from existing document metadata'
      FROM document
      WHERE folder_id IS NOT NULL AND space_id IS NOT NULL
      ORDER BY folder_id, created_at
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`
      ALTER TABLE document
        ADD CONSTRAINT knowledge_document_folder_requires_space
          CHECK (folder_id IS NULL OR space_id IS NOT NULL),
        ADD CONSTRAINT fk_document_space
          FOREIGN KEY (tenant_id, space_id) REFERENCES knowledge_space(tenant_id, id),
        ADD CONSTRAINT fk_document_folder
          FOREIGN KEY (tenant_id, space_id, folder_id)
          REFERENCES knowledge_folder(tenant_id, space_id, id)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document DROP CONSTRAINT fk_document_folder');
    await queryRunner.query('ALTER TABLE document DROP CONSTRAINT fk_document_space');
    await queryRunner.query(
      'ALTER TABLE document DROP CONSTRAINT knowledge_document_folder_requires_space',
    );
    await queryRunner.query(
      'ALTER TABLE document_effective_principal DROP CONSTRAINT document_effective_source_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE document_effective_principal ADD CONSTRAINT document_effective_source_type_check CHECK (source_resource_type = 'document')",
    );
    await queryRunner.query(
      'ALTER TABLE resource_acl DROP CONSTRAINT resource_acl_resource_type_check',
    );
    await queryRunner.query(
      "ALTER TABLE resource_acl ADD CONSTRAINT resource_acl_resource_type_check CHECK (resource_type = 'document')",
    );
    await queryRunner.query('ALTER TABLE document DROP COLUMN search_projection_version');
    await queryRunner.query('DROP TABLE audit_event');
    await queryRunner.query('DROP TABLE document_tag');
    await queryRunner.query('DROP TABLE knowledge_tag');
    await queryRunner.query('DROP TABLE knowledge_folder');
    await queryRunner.query('DROP TABLE knowledge_space');
    await queryRunner.query("DELETE FROM access_permission WHERE key = 'knowledge.manage'");
  }
}
