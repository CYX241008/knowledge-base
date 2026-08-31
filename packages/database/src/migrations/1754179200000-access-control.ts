import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AccessControl1754179200000 implements MigrationInterface {
  name = 'AccessControl1754179200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await queryRunner.query(`
      CREATE TABLE tenant (
        id uuid PRIMARY KEY,
        name varchar(255) NOT NULL,
        status varchar(32) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT tenant_status_check CHECK (status IN ('active', 'inactive'))
      )
    `);
    await queryRunner.query(`
      CREATE TABLE app_user (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        display_name varchar(255) NOT NULL,
        email varchar(320),
        status varchar(32) NOT NULL DEFAULT 'active',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT app_user_status_check CHECK (status IN ('active', 'inactive'))
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_app_user_tenant_name ON app_user (tenant_id, display_name)',
    );
    await queryRunner.query(`
      CREATE TABLE department (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        name varchar(255) NOT NULL,
        description text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_department_tenant_name UNIQUE (tenant_id, name)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE department_member (
        department_id uuid NOT NULL REFERENCES department(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (department_id, user_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_department_member_tenant_user ON department_member (tenant_id, user_id)',
    );
    await queryRunner.query(`
      CREATE TABLE access_role (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        name varchar(128) NOT NULL,
        description text,
        is_system boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_access_role_tenant_name UNIQUE (tenant_id, name)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE access_permission (
        key varchar(128) PRIMARY KEY,
        name varchar(255) NOT NULL,
        description text NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE user_role (
        user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
        role_id uuid NOT NULL REFERENCES access_role(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, role_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_user_role_tenant_role ON user_role (tenant_id, role_id)',
    );
    await queryRunner.query(`
      CREATE TABLE role_permission (
        role_id uuid NOT NULL REFERENCES access_role(id) ON DELETE CASCADE,
        permission_key varchar(128) NOT NULL REFERENCES access_permission(key) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_key)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE resource_acl (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        resource_type varchar(32) NOT NULL,
        resource_id uuid NOT NULL,
        principal_type varchar(32) NOT NULL,
        principal_id varchar(128) NOT NULL,
        permission varchar(128) NOT NULL REFERENCES access_permission(key),
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT resource_acl_resource_type_check CHECK (resource_type IN ('document')),
        CONSTRAINT resource_acl_principal_type_check
          CHECK (principal_type IN ('tenant', 'user', 'department', 'role')),
        CONSTRAINT uq_resource_acl
          UNIQUE (tenant_id, resource_type, resource_id, principal_id, permission)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_resource_acl_resource ON resource_acl (tenant_id, resource_type, resource_id)',
    );
    await queryRunner.query(`
      CREATE TABLE document_effective_principal (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
        principal_id varchar(128) NOT NULL,
        permission varchar(128) NOT NULL REFERENCES access_permission(key),
        source_resource_type varchar(32) NOT NULL,
        source_resource_id uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT document_effective_permission_check CHECK (permission = 'documents.read'),
        CONSTRAINT document_effective_source_type_check CHECK (source_resource_type = 'document'),
        CONSTRAINT uq_document_effective_principal
          UNIQUE (tenant_id, document_id, principal_id, permission)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_document_effective_principal_lookup ON document_effective_principal (tenant_id, principal_id)',
    );
    await queryRunner.query(
      'ALTER TABLE document ADD COLUMN acl_version integer NOT NULL DEFAULT 1',
    );

    await queryRunner.query(`
      INSERT INTO access_permission (key, name, description) VALUES
        ('access.manage', '访问控制管理', '管理租户成员、部门、角色和资源授权'),
        ('documents.create', '创建文档', '在租户内创建文档和新版本'),
        ('documents.read', '读取文档', '读取文档、检索分片和引用'),
        ('documents.update', '更新文档', '更新文档元数据和版本'),
        ('documents.delete', '删除文档', '归档并清理文档'),
        ('documents.manage', '管理文档', '发布、重试及管理文档生命周期'),
        ('documents.share', '共享文档', '修改文档的有效访问主体')
    `);

    await queryRunner.query(`
      INSERT INTO tenant (id, name)
      SELECT tenant_id, 'Tenant ' || left(tenant_id::text, 8)
      FROM (
        SELECT tenant_id FROM document
        UNION SELECT tenant_id FROM chat_conversation
        UNION SELECT tenant_id FROM ingestion_job
        UNION SELECT tenant_id FROM outbox_event
      ) existing_tenant
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO app_user (id, tenant_id, display_name)
      SELECT user_id, tenant_id, 'User ' || left(user_id::text, 8)
      FROM (
        SELECT created_by AS user_id, tenant_id FROM document WHERE created_by IS NOT NULL
        UNION SELECT created_by AS user_id, tenant_id FROM chat_conversation
      ) existing_user
      ON CONFLICT (id) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO resource_acl (
        id, tenant_id, resource_type, resource_id, principal_type, principal_id, permission, created_by
      )
      SELECT gen_random_uuid(), document.tenant_id, 'document', document.id,
             split_part(principal_id, ':', 1), principal_id, 'documents.read', document.created_by
      FROM document
      CROSS JOIN LATERAL unnest(document.access_principal_ids) AS principal_id
      WHERE principal_id ~ '^(tenant|user|department|role):[0-9a-fA-F-]{36}$'
      ON CONFLICT (tenant_id, resource_type, resource_id, principal_id, permission) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO resource_acl (
        id, tenant_id, resource_type, resource_id, principal_type, principal_id, permission, created_by
      )
      SELECT gen_random_uuid(), tenant_id, 'document', id, 'user', 'user:' || created_by::text,
             'documents.manage', created_by
      FROM document
      WHERE created_by IS NOT NULL
      ON CONFLICT (tenant_id, resource_type, resource_id, principal_id, permission) DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO document_effective_principal (
        id, tenant_id, document_id, principal_id, permission, source_resource_type, source_resource_id
      )
      SELECT gen_random_uuid(), document.tenant_id, document.id, principal_id,
             'documents.read', 'document', document.id
      FROM document
      CROSS JOIN LATERAL unnest(document.access_principal_ids) AS principal_id
      WHERE principal_id ~ '^(tenant|user|department|role):[0-9a-fA-F-]{36}$'
      ON CONFLICT (tenant_id, document_id, principal_id, permission) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE document DROP COLUMN acl_version');
    await queryRunner.query('DROP TABLE document_effective_principal');
    await queryRunner.query('DROP TABLE resource_acl');
    await queryRunner.query('DROP TABLE role_permission');
    await queryRunner.query('DROP TABLE user_role');
    await queryRunner.query('DROP TABLE access_permission');
    await queryRunner.query('DROP TABLE access_role');
    await queryRunner.query('DROP TABLE department_member');
    await queryRunner.query('DROP TABLE department');
    await queryRunner.query('DROP TABLE app_user');
    await queryRunner.query('DROP TABLE tenant');
  }
}
