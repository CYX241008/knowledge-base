import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import {
  tenantAccessPermissionKeys,
  type TenantAccessPermissionKey,
} from '@knowledge-base/contracts';
import { DataSource } from 'typeorm';
import type { AuthContext } from './auth-context';

type RoleRow = { id: string };
type PermissionRow = { permission_key: TenantAccessPermissionKey };
type DepartmentRow = { department_id: string };
type IdentityRow = {
  tenant_status: 'active' | 'inactive';
  user_tenant_id: string;
  user_status: 'active' | 'inactive';
};

@Injectable()
export class PrincipalResolverService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  async resolve(base: AuthContext): Promise<AuthContext> {
    await this.materializeIdentity(base);
    await this.assertActiveIdentity(base);
    if (base.mode === 'demo') await this.ensureDemoAdministrator(base);

    const [roles, departments, permissions] = await Promise.all([
      this.dataSource.query<RoleRow[]>(
        `SELECT role.id
         FROM access_role role
         INNER JOIN user_role assignment ON assignment.role_id = role.id
         WHERE assignment.tenant_id = $1 AND assignment.user_id = $2
           AND role.tenant_id = $1`,
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
         INNER JOIN access_role role ON role.id = permission.role_id
         INNER JOIN access_permission definition ON definition.key = permission.permission_key
         WHERE assignment.tenant_id = $1 AND assignment.user_id = $2
           AND role.tenant_id = $1
           AND definition.scope = 'tenant'`,
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
        ]),
      ],
      permissionKeys: [
        ...new Set([...base.permissionKeys, ...permissions.map((item) => item.permission_key)]),
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

  private async assertActiveIdentity(auth: AuthContext): Promise<void> {
    const rows = await this.dataSource.query<IdentityRow[]>(
      `SELECT tenant.status AS tenant_status,
              member.tenant_id AS user_tenant_id,
              member.status AS user_status
       FROM tenant
       INNER JOIN app_user member ON member.id = $2
       WHERE tenant.id = $1`,
      [auth.tenantId, auth.userId],
    );
    const identity = rows[0];
    if (
      !identity ||
      identity.user_tenant_id !== auth.tenantId ||
      identity.tenant_status !== 'active' ||
      identity.user_status !== 'active'
    ) {
      throw new UnauthorizedException({
        code: 'IDENTITY_INACTIVE',
        message: 'The tenant or user account is inactive',
      });
    }
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
        [role.id, tenantAccessPermissionKeys],
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
