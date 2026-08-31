import { Inject, Injectable } from '@nestjs/common';
import { accessPermissionKeys, type AccessPermissionKey } from '@knowledge-base/contracts';
import { DataSource } from 'typeorm';
import type { AuthContext } from './auth-context';

type RoleRow = { id: string };
type PermissionRow = { permission_key: AccessPermissionKey };
type DepartmentRow = { department_id: string };

@Injectable()
export class PrincipalResolverService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async resolve(base: AuthContext): Promise<AuthContext> {
    await this.materializeIdentity(base);
    if (base.mode === 'demo') await this.ensureDemoAdministrator(base);

    const [roles, departments, permissions] = await Promise.all([
      this.dataSource.query<RoleRow[]>(
        `SELECT role.id
         FROM access_role role
         INNER JOIN user_role assignment ON assignment.role_id = role.id
         WHERE assignment.tenant_id = $1 AND assignment.user_id = $2`,
        [base.tenantId, base.userId],
      ),
      this.dataSource.query<DepartmentRow[]>(
        `SELECT department_id
         FROM department_member
         WHERE tenant_id = $1 AND user_id = $2`,
        [base.tenantId, base.userId],
      ),
      this.dataSource.query<PermissionRow[]>(
        `SELECT DISTINCT permission.permission_key
         FROM role_permission permission
         INNER JOIN user_role assignment ON assignment.role_id = permission.role_id
         WHERE assignment.tenant_id = $1 AND assignment.user_id = $2`,
        [base.tenantId, base.userId],
      ),
    ]);

    return {
      ...base,
      principalIds: [
        ...new Set([
          `tenant:${base.tenantId}`,
          `user:${base.userId}`,
          ...base.principalIds,
          ...roles.map((role) => `role:${role.id}`),
          ...departments.map((department) => `department:${department.department_id}`),
          ...permissions.map((permission) => `permission:${permission.permission_key}`),
        ]),
      ],
    };
  }

  private async materializeIdentity(auth: AuthContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.query(
        `INSERT INTO tenant (id, name)
         VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [auth.tenantId, auth.mode === 'demo' ? '演示租户' : `Tenant ${auth.tenantId.slice(0, 8)}`],
      );
      await manager.query(
        `INSERT INTO app_user (id, tenant_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
        [
          auth.userId,
          auth.tenantId,
          auth.mode === 'demo' ? '演示管理员' : `User ${auth.userId.slice(0, 8)}`,
        ],
      );
    });
  }

  private async ensureDemoAdministrator(auth: AuthContext): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const roles = await manager.query<RoleRow[]>(
        `INSERT INTO access_role (id, tenant_id, name, description, is_system)
         VALUES (gen_random_uuid(), $1, 'Administrator', '演示环境系统管理员', true)
         ON CONFLICT (tenant_id, name)
         DO UPDATE SET is_system = true, updated_at = now()
         RETURNING id`,
        [auth.tenantId],
      );
      const role = roles[0];
      if (!role) throw new Error('Failed to materialize the demo administrator role');
      await manager.query(
        `INSERT INTO role_permission (role_id, permission_key)
         SELECT $1, unnest($2::varchar[])
         ON CONFLICT (role_id, permission_key) DO NOTHING`,
        [role.id, accessPermissionKeys],
      );
      await manager.query(
        `INSERT INTO user_role (user_id, role_id, tenant_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, role_id) DO NOTHING`,
        [auth.userId, role.id, auth.tenantId],
      );
    });
  }
}
