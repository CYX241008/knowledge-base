import { UnauthorizedException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from './auth-context';
import { PrincipalResolverService } from './principal-resolver.service';

const base: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: [
    'tenant:11111111-1111-4111-8111-111111111111',
    'user:22222222-2222-4222-8222-222222222222',
  ],
  permissionKeys: [],
  mode: 'jwt',
};

describe('PrincipalResolverService', () => {
  it('rejects inactive identities', async () => {
    const dataSource = dataSourceWithQueries([
      [
        {
          tenant_status: 'active',
          user_tenant_id: base.tenantId,
          user_status: 'inactive',
        },
      ],
    ]);
    await expect(new PrincipalResolverService(dataSource).resolve(base)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('keeps ACL principals separate from tenant permissions', async () => {
    const roleId = '33333333-3333-4333-8333-333333333333';
    const departmentId = '44444444-4444-4444-8444-444444444444';
    const dataSource = dataSourceWithQueries([
      [
        {
          tenant_status: 'active',
          user_tenant_id: base.tenantId,
          user_status: 'active',
        },
      ],
      [{ id: roleId }],
      [{ department_id: departmentId }],
      [{ permission_key: 'documents.create' }],
    ]);

    const resolved = await new PrincipalResolverService(dataSource).resolve(base);
    expect(resolved.principalIds).toContain(`role:${roleId}`);
    expect(resolved.principalIds).toContain(`department:${departmentId}`);
    expect(resolved.principalIds.some((principal) => principal.startsWith('permission:'))).toBe(
      false,
    );
    expect(resolved.permissionKeys).toEqual(['documents.create']);
  });
});

function dataSourceWithQueries(results: unknown[]): DataSource {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return {
    transaction: vi.fn(async (callback: (manager: { query: typeof query }) => Promise<void>) => {
      await callback({ query: vi.fn(async () => []) });
    }),
    query,
  } as unknown as DataSource;
}
