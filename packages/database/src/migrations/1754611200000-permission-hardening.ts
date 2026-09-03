import type { MigrationInterface, QueryRunner } from 'typeorm';

export class PermissionHardening1754611200000 implements MigrationInterface {
  name = 'PermissionHardening1754611200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE access_permission
      ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'resource'
    `);
    await queryRunner.query(`
      UPDATE access_permission
      SET scope = 'tenant'
      WHERE key IN (
        'access.manage',
        'system.manage',
        'knowledge.manage',
        'documents.create',
        'documents.review'
      )
    `);
    await queryRunner.query(`
      ALTER TABLE access_permission
      ADD CONSTRAINT access_permission_scope_check CHECK (scope IN ('tenant', 'resource')),
      ADD CONSTRAINT uq_access_permission_key_scope UNIQUE (key, scope)
    `);
    await queryRunner.query(`
      DELETE FROM role_permission
      WHERE permission_key IN (
        'documents.read',
        'documents.update',
        'documents.delete',
        'documents.manage',
        'documents.share'
      )
    `);
    await queryRunner.query(`
      CREATE FUNCTION enforce_access_permission_scope()
      RETURNS trigger AS $$
      DECLARE
        actual_scope varchar(16);
        permission_key varchar(128);
      BEGIN
        permission_key := COALESCE(
          to_jsonb(NEW) ->> 'permission_key',
          to_jsonb(NEW) ->> 'permission'
        );
        SELECT scope INTO actual_scope
        FROM access_permission
        WHERE key = permission_key;
        IF actual_scope IS DISTINCT FROM TG_ARGV[0] THEN
          RAISE EXCEPTION 'Permission % must have % scope',
            permission_key, TG_ARGV[0];
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      CREATE TRIGGER role_permission_scope_check
      BEFORE INSERT OR UPDATE ON role_permission
      FOR EACH ROW EXECUTE FUNCTION enforce_access_permission_scope('tenant')
    `);
    await queryRunner.query(`
      CREATE TRIGGER resource_acl_permission_scope_check
      BEFORE INSERT OR UPDATE ON resource_acl
      FOR EACH ROW EXECUTE FUNCTION enforce_access_permission_scope('resource')
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM user_role assignment
          INNER JOIN app_user member ON member.id = assignment.user_id
          INNER JOIN access_role role ON role.id = assignment.role_id
          WHERE assignment.tenant_id <> member.tenant_id
             OR assignment.tenant_id <> role.tenant_id
        ) THEN
          RAISE EXCEPTION 'Cannot add tenant-safe user_role constraints: inconsistent rows exist';
        END IF;
        IF EXISTS (
          SELECT 1
          FROM department_member membership
          INNER JOIN app_user member ON member.id = membership.user_id
          INNER JOIN department ON department.id = membership.department_id
          WHERE membership.tenant_id <> member.tenant_id
             OR membership.tenant_id <> department.tenant_id
        ) THEN
          RAISE EXCEPTION 'Cannot add tenant-safe department_member constraints: inconsistent rows exist';
        END IF;
      END
      $$
    `);

    await queryRunner.query(
      'ALTER TABLE app_user ADD CONSTRAINT uq_app_user_tenant_id UNIQUE (tenant_id, id)',
    );
    await queryRunner.query(
      'ALTER TABLE department ADD CONSTRAINT uq_department_tenant_id UNIQUE (tenant_id, id)',
    );
    await queryRunner.query(
      'ALTER TABLE access_role ADD CONSTRAINT uq_access_role_tenant_id UNIQUE (tenant_id, id)',
    );

    await queryRunner.query('ALTER TABLE user_role DROP CONSTRAINT user_role_user_id_fkey');
    await queryRunner.query('ALTER TABLE user_role DROP CONSTRAINT user_role_role_id_fkey');
    await queryRunner.query(`
      ALTER TABLE user_role
      ADD CONSTRAINT fk_user_role_tenant_user
        FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT fk_user_role_tenant_role
        FOREIGN KEY (tenant_id, role_id) REFERENCES access_role(tenant_id, id) ON DELETE CASCADE
    `);

    await queryRunner.query(
      'ALTER TABLE department_member DROP CONSTRAINT department_member_department_id_fkey',
    );
    await queryRunner.query(
      'ALTER TABLE department_member DROP CONSTRAINT department_member_user_id_fkey',
    );
    await queryRunner.query(`
      ALTER TABLE department_member
      ADD CONSTRAINT fk_department_member_tenant_department
        FOREIGN KEY (tenant_id, department_id) REFERENCES department(tenant_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT fk_department_member_tenant_user
        FOREIGN KEY (tenant_id, user_id) REFERENCES app_user(tenant_id, id) ON DELETE CASCADE
    `);

    await queryRunner.query(
      'ALTER TABLE knowledge_folder DROP CONSTRAINT fk_knowledge_folder_parent',
    );
    await queryRunner.query(`
      ALTER TABLE knowledge_folder
      ADD CONSTRAINT fk_knowledge_folder_tenant_parent
        FOREIGN KEY (tenant_id, space_id, parent_id)
        REFERENCES knowledge_folder(tenant_id, space_id, id)
    `);

    await queryRunner.query(`
      ALTER TABLE resource_acl
      ADD CONSTRAINT resource_acl_principal_id_check
      CHECK (
        principal_id ~ (
          '^' || principal_type ||
          ':[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89ab][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        )
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TRIGGER resource_acl_permission_scope_check ON resource_acl');
    await queryRunner.query('DROP TRIGGER role_permission_scope_check ON role_permission');
    await queryRunner.query('DROP FUNCTION enforce_access_permission_scope');
    await queryRunner.query(
      'ALTER TABLE resource_acl DROP CONSTRAINT resource_acl_principal_id_check',
    );
    await queryRunner.query(
      'ALTER TABLE knowledge_folder DROP CONSTRAINT fk_knowledge_folder_tenant_parent',
    );
    await queryRunner.query(`
      ALTER TABLE knowledge_folder
      ADD CONSTRAINT fk_knowledge_folder_parent
        FOREIGN KEY (parent_id) REFERENCES knowledge_folder(id)
    `);

    await queryRunner.query(
      'ALTER TABLE department_member DROP CONSTRAINT fk_department_member_tenant_user',
    );
    await queryRunner.query(
      'ALTER TABLE department_member DROP CONSTRAINT fk_department_member_tenant_department',
    );
    await queryRunner.query(`
      ALTER TABLE department_member
      ADD CONSTRAINT department_member_department_id_fkey
        FOREIGN KEY (department_id) REFERENCES department(id) ON DELETE CASCADE,
      ADD CONSTRAINT department_member_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
    `);

    await queryRunner.query('ALTER TABLE user_role DROP CONSTRAINT fk_user_role_tenant_role');
    await queryRunner.query('ALTER TABLE user_role DROP CONSTRAINT fk_user_role_tenant_user');
    await queryRunner.query(`
      ALTER TABLE user_role
      ADD CONSTRAINT user_role_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE,
      ADD CONSTRAINT user_role_role_id_fkey
        FOREIGN KEY (role_id) REFERENCES access_role(id) ON DELETE CASCADE
    `);

    await queryRunner.query('ALTER TABLE access_role DROP CONSTRAINT uq_access_role_tenant_id');
    await queryRunner.query('ALTER TABLE department DROP CONSTRAINT uq_department_tenant_id');
    await queryRunner.query('ALTER TABLE app_user DROP CONSTRAINT uq_app_user_tenant_id');
    await queryRunner.query(
      'ALTER TABLE access_permission DROP CONSTRAINT uq_access_permission_key_scope',
    );
    await queryRunner.query(
      'ALTER TABLE access_permission DROP CONSTRAINT access_permission_scope_check',
    );
    await queryRunner.query('ALTER TABLE access_permission DROP COLUMN scope');
  }
}
