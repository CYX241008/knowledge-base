import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { CreateAccessRoleRequest } from '@knowledge-base/contracts';
import type { DocumentEntity } from '@knowledge-base/database';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/auth-context';
import type { IngestionService } from '../ingestion/ingestion.service';
import { AccessControlService } from './access-control.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const rolePrincipal = 'role:44444444-4444-4444-8444-444444444444';

function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId,
    userId,
    principalIds: [`tenant:${tenantId}`, `user:${userId}`, rolePrincipal],
    permissionKeys: [],
    mode: 'jwt',
    ...overrides,
  };
}

function service(document: Partial<DocumentEntity>, query = vi.fn(async () => [])) {
  const repository = {
    findOne: vi.fn(async () => ({
      id: documentId,
      tenantId,
      createdBy: null,
      accessPrincipalIds: [],
      deletedAt: null,
      ...document,
    })),
  };
  const dataSource = {
    getRepository: vi.fn(() => repository),
    query,
  } as unknown as DataSource;
  return {
    access: new AccessControlService(dataSource, {
      dispatchPending: vi.fn(),
    } as unknown as IngestionService),
    query,
  };
}

describe('AccessControlService authorization', () => {
  it('allows access.manage to satisfy tenant permissions', () => {
    const { access } = service({});
    expect(() =>
      access.assertPermission(auth({ permissionKeys: ['access.manage'] }), 'documents.create'),
    ).not.toThrow();
  });

  it('rejects a missing tenant permission', () => {
    const { access } = service({});
    expect(() => access.assertPermission(auth(), 'documents.create')).toThrow(ForbiddenException);
  });

  it('rejects resource permissions in tenant roles', async () => {
    const { access } = service({});
    await expect(
      access.createRole(auth({ permissionKeys: ['access.manage'] }), {
        name: 'Invalid role',
        permissionKeys: ['documents.read'],
      } as unknown as CreateAccessRoleRequest),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses the effective read principals for document reads', async () => {
    const { access } = service({ accessPrincipalIds: [rolePrincipal] });
    await expect(
      access.assertDocumentPermission(auth(), documentId, 'documents.read'),
    ).resolves.toBeDefined();
  });

  it('does not let a delete grant authorize document updates', async () => {
    const query = vi.fn(async (_sql: string, parameters: unknown[]) => {
      const allowedPermissions = parameters[3] as string[];
      return allowedPermissions.includes('documents.delete') ? [{ allowed: true }] : [];
    });
    const { access } = service({}, query);
    await expect(
      access.assertDocumentPermission(auth(), documentId, 'documents.update'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      access.assertDocumentPermission(auth(), documentId, 'documents.delete'),
    ).resolves.toBeDefined();
  });

  it('lets the document creator manage the resource', async () => {
    const { access, query } = service({ createdBy: userId });
    await expect(
      access.assertDocumentPermission(auth(), documentId, 'documents.share'),
    ).resolves.toBeDefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not grant document reads from ownership alone', async () => {
    const { access } = service({ createdBy: userId });
    await expect(
      access.assertDocumentPermission(auth(), documentId, 'documents.read'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
