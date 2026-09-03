import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AccessOverviewResponse,
  AccessPermissionKey,
  AccessPrincipalDirectoryResponse,
  AssignDepartmentMembersRequest,
  AssignMemberRolesRequest,
  CreateAccessRoleRequest,
  CreateDepartmentRequest,
  DocumentAclGrant,
  DocumentResourcePermissionKey,
  ReplaceDocumentAclResponse,
  TenantAccessPermissionKey,
  UpsertOrganizationMemberRequest,
} from '@knowledge-base/contracts';
import {
  documentResourcePermissionKeys,
  tenantAccessPermissionKeys,
} from '@knowledge-base/contracts';
import {
  AccessPermissionEntity,
  AccessRoleEntity,
  AppUserEntity,
  AuditEventEntity,
  DepartmentEntity,
  DepartmentMemberEntity,
  DocumentChunkEntity,
  DocumentEffectivePrincipalEntity,
  DocumentEntity,
  OutboxEventEntity,
  ResourceAclEntity,
  RolePermissionEntity,
  TenantEntity,
  UserRoleEntity,
} from '@knowledge-base/database';
import {
  parseAccessPrincipalId,
  principalsOverlap,
  uniqueAccessPrincipalIds,
} from '@knowledge-base/domain';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import type { AuthContext } from '../auth/auth-context';
import { IngestionService } from '../ingestion/ingestion.service';

@Injectable()
export class AccessControlService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(IngestionService) private readonly ingestionService: IngestionService,
  ) {}

  async overview(auth: AuthContext): Promise<AccessOverviewResponse> {
    this.assertTenantAdministration(auth);
    const [
      tenant,
      members,
      roles,
      permissions,
      departments,
      documents,
      userRoles,
      rolePermissions,
      departmentMembers,
      documentAclRows,
    ] = await Promise.all([
      this.dataSource.getRepository(TenantEntity).findOneBy({ id: auth.tenantId }),
      this.dataSource.getRepository(AppUserEntity).find({
        where: { tenantId: auth.tenantId },
        order: { displayName: 'ASC' },
      }),
      this.dataSource.getRepository(AccessRoleEntity).find({
        where: { tenantId: auth.tenantId },
        order: { isSystem: 'DESC', name: 'ASC' },
      }),
      this.dataSource.getRepository(AccessPermissionEntity).find({ order: { key: 'ASC' } }),
      this.dataSource.getRepository(DepartmentEntity).find({
        where: { tenantId: auth.tenantId },
        order: { name: 'ASC' },
      }),
      this.dataSource.getRepository(DocumentEntity).find({
        where: { tenantId: auth.tenantId, deletedAt: IsNull() },
        order: { updatedAt: 'DESC' },
        take: 200,
      }),
      this.dataSource.getRepository(UserRoleEntity).findBy({ tenantId: auth.tenantId }),
      this.dataSource.getRepository(RolePermissionEntity).find(),
      this.dataSource.getRepository(DepartmentMemberEntity).findBy({ tenantId: auth.tenantId }),
      this.dataSource.getRepository(ResourceAclEntity).find({
        where: {
          tenantId: auth.tenantId,
          resourceType: 'document',
          permission: In([...documentResourcePermissionKeys]),
        },
      }),
    ]);
    if (!tenant) throw new NotFoundException(`Tenant ${auth.tenantId} not found`);

    return {
      tenant: { id: tenant.id, name: tenant.name },
      members: members.map((member) => ({
        id: member.id,
        displayName: member.displayName,
        email: member.email,
        status: member.status,
        roleIds: userRoles.filter((item) => item.userId === member.id).map((item) => item.roleId),
        departmentIds: departmentMembers
          .filter((item) => item.userId === member.id)
          .map((item) => item.departmentId),
      })),
      roles: roles.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        permissionKeys: rolePermissions
          .filter((item) => item.roleId === role.id)
          .map((item) => item.permissionKey)
          .filter(isTenantPermissionKey),
        memberCount: userRoles.filter((item) => item.roleId === role.id).length,
      })),
      permissions: permissions.map((permission) => ({
        key: permission.key,
        name: permission.name,
        description: permission.description,
        scope: permission.scope,
      })),
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        description: department.description,
        memberIds: departmentMembers
          .filter((item) => item.departmentId === department.id)
          .map((item) => item.userId),
      })),
      documents: documents.map((document) => ({
        id: document.id,
        title: document.title,
        status: document.status,
        aclVersion: document.aclVersion,
        directGrants: groupDocumentAclGrants(
          documentAclRows.filter((row) => row.resourceId === document.id),
        ),
        effectivePrincipalIds: uniqueAccessPrincipalIds(document.accessPrincipalIds),
        principalIds: uniqueAccessPrincipalIds(document.accessPrincipalIds),
      })),
    };
  }

  async principalDirectory(auth: AuthContext): Promise<AccessPrincipalDirectoryResponse> {
    this.assertKnowledgeAdministration(auth);
    const [tenant, members, roles, departments] = await Promise.all([
      this.dataSource.getRepository(TenantEntity).findOneBy({ id: auth.tenantId }),
      this.dataSource.getRepository(AppUserEntity).find({
        where: { tenantId: auth.tenantId, status: 'active' },
        order: { displayName: 'ASC' },
      }),
      this.dataSource.getRepository(AccessRoleEntity).find({
        where: { tenantId: auth.tenantId },
        order: { name: 'ASC' },
      }),
      this.dataSource.getRepository(DepartmentEntity).find({
        where: { tenantId: auth.tenantId },
        order: { name: 'ASC' },
      }),
    ]);
    if (!tenant) throw new NotFoundException(`Tenant ${auth.tenantId} not found`);
    return {
      tenant: { id: tenant.id, name: tenant.name },
      principals: [
        { id: `tenant:${tenant.id}`, type: 'tenant', label: tenant.name },
        ...members.map((member) => ({
          id: `user:${member.id}` as const,
          type: 'user' as const,
          label: member.displayName,
        })),
        ...roles.map((role) => ({
          id: `role:${role.id}` as const,
          type: 'role' as const,
          label: role.name,
        })),
        ...departments.map((department) => ({
          id: `department:${department.id}` as const,
          type: 'department' as const,
          label: department.name,
        })),
      ],
    };
  }

  async upsertMember(
    auth: AuthContext,
    input: UpsertOrganizationMemberRequest,
  ): Promise<{ memberId: string }> {
    this.assertTenantAdministration(auth);
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AppUserEntity);
      const existing = await repository.findOneBy({ id: input.id });
      if (existing && existing.tenantId !== auth.tenantId) {
        throw new ConflictException({
          code: 'MEMBER_BELONGS_TO_ANOTHER_TENANT',
          message: 'The member identifier already belongs to another tenant',
        });
      }
      const member = await repository.save(
        repository.create({
          ...existing,
          id: input.id,
          tenantId: auth.tenantId,
          displayName: input.displayName,
          email: input.email ?? null,
          status: existing?.status ?? 'active',
        }),
      );
      await this.recordAudit(manager, auth, 'access.member.upserted', 'user', member.id, {
        created: !existing,
        displayName: member.displayName,
        email: member.email,
        status: member.status,
      });
    });
    return { memberId: input.id };
  }

  async createRole(auth: AuthContext, input: CreateAccessRoleRequest): Promise<{ roleId: string }> {
    this.assertTenantAdministration(auth);
    const roleId = randomUUID();
    const keys = [...new Set(input.permissionKeys)];
    if (keys.some((key) => !tenantPermissionKeySet.has(key))) {
      throw new BadRequestException({
        code: 'RESOURCE_PERMISSION_NOT_ROLE_ASSIGNABLE',
        message: 'Document resource permissions must be granted through a resource ACL',
      });
    }
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(AccessRoleEntity).save(
          manager.getRepository(AccessRoleEntity).create({
            id: roleId,
            tenantId: auth.tenantId,
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
          }),
        );
        if (keys.length > 0) {
          await manager
            .getRepository(RolePermissionEntity)
            .save(keys.map((permissionKey) => ({ roleId, permissionKey })));
        }
        await this.recordAudit(manager, auth, 'access.role.created', 'role', roleId, {
          name: input.name,
          permissionKeys: keys,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'ROLE_NAME_EXISTS',
          message: 'A role with this name already exists',
        });
      }
      throw error;
    }
    return { roleId };
  }

  async deleteRole(auth: AuthContext, roleId: string): Promise<{ roleId: string; deleted: true }> {
    this.assertTenantAdministration(auth);
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(AccessRoleEntity);
      const role = await repository.findOne({
        where: { id: roleId, tenantId: auth.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!role) throw new NotFoundException(`Role ${roleId} not found`);
      if (role.isSystem) {
        throw new BadRequestException({
          code: 'SYSTEM_ROLE_IMMUTABLE',
          message: 'System roles cannot be deleted',
        });
      }
      const references = await manager.getRepository(ResourceAclEntity).countBy({
        tenantId: auth.tenantId,
        principalId: `role:${roleId}`,
      });
      if (references > 0) {
        throw new ConflictException({
          code: 'ROLE_IN_USE',
          message: 'Remove this role from document access lists before deleting it',
        });
      }
      const permissionKeys = (
        await manager.getRepository(RolePermissionEntity).findBy({ roleId })
      ).map((item) => item.permissionKey);
      await repository.remove(role);
      await this.recordAudit(manager, auth, 'access.role.deleted', 'role', roleId, {
        name: role.name,
        permissionKeys,
      });
    });
    return { roleId, deleted: true };
  }

  async assignMemberRoles(
    auth: AuthContext,
    userId: string,
    input: AssignMemberRolesRequest,
  ): Promise<{ userId: string; roleIds: string[] }> {
    this.assertTenantAdministration(auth);
    const roleIds = [...new Set(input.roleIds)];
    await this.requireMembers(auth.tenantId, [userId]);
    await this.requireRoles(auth.tenantId, roleIds);
    await this.dataSource.transaction(async (manager) => {
      const previousRoleIds = (
        await manager.getRepository(UserRoleEntity).findBy({ tenantId: auth.tenantId, userId })
      ).map((assignment) => assignment.roleId);
      await manager.query(
        `DELETE FROM user_role assignment
         USING access_role role
         WHERE assignment.role_id = role.id
           AND assignment.tenant_id = $1
           AND assignment.user_id = $2
           AND role.is_system = false`,
        [auth.tenantId, userId],
      );
      if (roleIds.length > 0) {
        await manager
          .getRepository(UserRoleEntity)
          .save(roleIds.map((roleId) => ({ userId, roleId, tenantId: auth.tenantId })));
      }
      const effectiveRoleIds = (
        await manager.getRepository(UserRoleEntity).findBy({ tenantId: auth.tenantId, userId })
      ).map((assignment) => assignment.roleId);
      await this.recordAudit(manager, auth, 'access.member.roles.updated', 'user', userId, {
        before: previousRoleIds,
        after: effectiveRoleIds,
      });
    });
    const assignments = await this.dataSource
      .getRepository(UserRoleEntity)
      .findBy({ tenantId: auth.tenantId, userId });
    return { userId, roleIds: assignments.map((assignment) => assignment.roleId) };
  }

  async createDepartment(
    auth: AuthContext,
    input: CreateDepartmentRequest,
  ): Promise<{ departmentId: string }> {
    this.assertTenantAdministration(auth);
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(DepartmentEntity).save({
          id,
          tenantId: auth.tenantId,
          name: input.name,
          description: input.description ?? null,
        });
        await this.recordAudit(manager, auth, 'access.department.created', 'department', id, {
          name: input.name,
          description: input.description ?? null,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException({
          code: 'DEPARTMENT_NAME_EXISTS',
          message: 'A department with this name already exists',
        });
      }
      throw error;
    }
    return { departmentId: id };
  }

  async assignDepartmentMembers(
    auth: AuthContext,
    departmentId: string,
    input: AssignDepartmentMembersRequest,
  ): Promise<{ departmentId: string; userIds: string[] }> {
    this.assertTenantAdministration(auth);
    const department = await this.dataSource
      .getRepository(DepartmentEntity)
      .findOneBy({ id: departmentId, tenantId: auth.tenantId });
    if (!department) throw new NotFoundException(`Department ${departmentId} not found`);
    const userIds = [...new Set(input.userIds)];
    await this.requireMembers(auth.tenantId, userIds);
    await this.dataSource.transaction(async (manager) => {
      const previousUserIds = (
        await manager
          .getRepository(DepartmentMemberEntity)
          .findBy({ tenantId: auth.tenantId, departmentId })
      ).map((membership) => membership.userId);
      await manager.getRepository(DepartmentMemberEntity).delete({
        tenantId: auth.tenantId,
        departmentId,
      });
      if (userIds.length > 0) {
        await manager
          .getRepository(DepartmentMemberEntity)
          .save(userIds.map((userId) => ({ departmentId, userId, tenantId: auth.tenantId })));
      }
      await this.recordAudit(
        manager,
        auth,
        'access.department.members.updated',
        'department',
        departmentId,
        { before: previousUserIds, after: userIds },
      );
    });
    return { departmentId, userIds };
  }

  async replaceDocumentAcl(
    auth: AuthContext,
    documentId: string,
    grants: readonly DocumentAclGrant[],
  ): Promise<ReplaceDocumentAclResponse> {
    await this.assertDocumentPermission(auth, documentId, 'documents.share');
    const normalized = normalizeDocumentAclGrants(grants);
    await this.validatePrincipals(
      auth.tenantId,
      normalized.map((grant) => grant.principalId),
    );

    const response = await this.dataSource.transaction(async (manager) => {
      const documents = manager.getRepository(DocumentEntity);
      const document = await documents.findOne({
        where: { id: documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found`);

      await manager.getRepository(ResourceAclEntity).delete({
        tenantId: auth.tenantId,
        resourceType: 'document',
        resourceId: documentId,
        permission: In([...documentResourcePermissionKeys]),
      });
      await this.saveDocumentAclGrants(
        manager,
        auth.tenantId,
        document.id,
        normalized,
        auth.userId,
      );

      document.aclVersion += 1;
      document.updatedBy = auth.userId;
      const effectivePrincipalIds = await this.recomputeDocumentEffectiveAcl(manager, document);
      await documents.save(document);
      await this.createAclProjectionIntent(manager, document);
      await this.recordAudit(manager, auth, 'document.acl.replaced', 'document', document.id, {
        directGrants: normalized,
        effectivePrincipalIds,
      });
      return {
        documentId,
        aclVersion: document.aclVersion,
        directGrants: normalized,
        effectivePrincipalIds,
        principalIds: effectivePrincipalIds,
        projectionStatus: 'queued' as const,
      };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async createInitialDocumentAcl(
    manager: EntityManager,
    document: DocumentEntity,
    principalIds: readonly string[],
    createdBy: string | null,
  ): Promise<void> {
    const normalized = uniqueAccessPrincipalIds(principalIds);
    await this.validatePrincipals(document.tenantId, normalized, manager);
    if (normalized.length > 0) {
      await this.saveResourceReadAcl(
        manager,
        document.tenantId,
        'document',
        document.id,
        normalized,
        createdBy,
      );
    }
    if (createdBy) {
      const principalId = `user:${createdBy}`;
      await manager.getRepository(ResourceAclEntity).save({
        id: randomUUID(),
        tenantId: document.tenantId,
        resourceType: 'document',
        resourceId: document.id,
        principalType: 'user',
        principalId,
        permission: 'documents.manage',
        createdBy,
      });
    }
    await this.recomputeDocumentEffectiveAcl(manager, document);
  }

  async assertDocumentPermission(
    auth: AuthContext,
    documentId: string,
    permission: DocumentResourcePermissionKey,
  ): Promise<DocumentEntity> {
    const document = await this.dataSource.getRepository(DocumentEntity).findOne({
      where: { id: documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);
    if (
      permission !== 'documents.read' &&
      (this.hasPermission(auth, 'access.manage') || document.createdBy === auth.userId)
    ) {
      return document;
    }
    if (
      permission === 'documents.read' &&
      principalsOverlap(document.accessPrincipalIds, auth.principalIds)
    ) {
      return document;
    }
    if (permission === 'documents.read') {
      throw new ForbiddenException({
        code: 'DOCUMENT_PERMISSION_DENIED',
        message: 'Document permission documents.read is required',
      });
    }
    const allowedPermissions =
      permission === 'documents.manage' ? ['documents.manage'] : [permission, 'documents.manage'];
    const rows = await this.dataSource.query<Array<{ allowed: boolean }>>(
      `SELECT true AS allowed
       FROM resource_acl
       WHERE tenant_id = $1 AND resource_type = 'document' AND resource_id = $2
         AND principal_id = ANY($3::varchar[]) AND permission = ANY($4::varchar[])
       LIMIT 1`,
      [auth.tenantId, documentId, auth.principalIds, allowedPermissions],
    );
    if (rows.length === 0) {
      throw new ForbiddenException({
        code: 'DOCUMENT_PERMISSION_DENIED',
        message: `Document permission ${permission} is required`,
      });
    }
    return document;
  }

  async assertDocumentRead(auth: AuthContext, documentId: string): Promise<DocumentEntity> {
    return this.assertDocumentPermission(auth, documentId, 'documents.read');
  }

  async documentPermissions(
    auth: AuthContext,
    document: DocumentEntity,
  ): Promise<DocumentResourcePermissionKey[]> {
    const permissions = new Set<DocumentResourcePermissionKey>();
    if (principalsOverlap(document.accessPrincipalIds, auth.principalIds)) {
      permissions.add('documents.read');
    }
    if (this.hasPermission(auth, 'access.manage') || document.createdBy === auth.userId) {
      for (const permission of documentResourcePermissionKeys) {
        if (permission !== 'documents.read') permissions.add(permission);
      }
    }
    const rows = await this.dataSource.getRepository(ResourceAclEntity).find({
      where: {
        tenantId: auth.tenantId,
        resourceType: 'document',
        resourceId: document.id,
        principalId: In(auth.principalIds),
        permission: In([...documentResourcePermissionKeys]),
      },
    });
    for (const row of rows) {
      permissions.add(row.permission as DocumentResourcePermissionKey);
    }
    if (permissions.has('documents.manage')) {
      for (const permission of documentResourcePermissionKeys) {
        if (permission !== 'documents.read') permissions.add(permission);
      }
    }
    return [...permissions];
  }

  assertPermission(auth: AuthContext, permission: TenantAccessPermissionKey): void {
    if (!this.hasPermission(auth, permission)) {
      throw new ForbiddenException({
        code: 'TENANT_PERMISSION_DENIED',
        message: `Tenant permission ${permission} is required`,
      });
    }
  }

  hasPermission(auth: AuthContext, permission: TenantAccessPermissionKey): boolean {
    return (
      auth.permissionKeys.includes('access.manage') || auth.permissionKeys.includes(permission)
    );
  }

  assertTenantAdministration(auth: AuthContext): void {
    this.assertPermission(auth, 'access.manage');
  }

  assertKnowledgeAdministration(auth: AuthContext): void {
    this.assertPermission(auth, 'knowledge.manage');
  }

  assertDocumentReview(auth: AuthContext): void {
    this.assertPermission(auth, 'documents.review');
  }

  canEditSystemSettings(auth: AuthContext): boolean {
    return this.hasPermission(auth, 'system.manage');
  }

  assertSystemAdministration(auth: AuthContext): void {
    if (!this.canEditSystemSettings(auth)) {
      throw new ForbiddenException({
        code: 'SYSTEM_ADMINISTRATION_DENIED',
        message: 'System administration permission is required',
      });
    }
  }

  assertGovernanceRead(auth: AuthContext): void {
    if (!this.canEditSystemSettings(auth) && !this.hasPermission(auth, 'knowledge.manage')) {
      throw new ForbiddenException({
        code: 'GOVERNANCE_READ_DENIED',
        message: 'Knowledge governance permission is required',
      });
    }
  }

  async saveResourceReadAcl(
    manager: EntityManager,
    tenantId: string,
    resourceType: 'document' | 'space' | 'folder',
    resourceId: string,
    principalIds: readonly string[],
    createdBy: string | null,
  ): Promise<void> {
    await manager.getRepository(ResourceAclEntity).save(
      principalIds.map((principalId) => {
        const principal = parseAccessPrincipalId(principalId);
        if (!principal) throw new BadRequestException('Invalid access principal');
        return {
          id: randomUUID(),
          tenantId,
          resourceType,
          resourceId,
          principalType: principal.type,
          principalId,
          permission: 'documents.read' as const,
          createdBy,
        };
      }),
    );
  }

  async saveDocumentAclGrants(
    manager: EntityManager,
    tenantId: string,
    documentId: string,
    grants: readonly DocumentAclGrant[],
    createdBy: string | null,
  ): Promise<void> {
    const rows = grants.flatMap((grant) =>
      grant.permissions.map((permission) => {
        const principal = parseAccessPrincipalId(grant.principalId);
        if (!principal) throw new BadRequestException('Invalid access principal');
        return {
          id: randomUUID(),
          tenantId,
          resourceType: 'document' as const,
          resourceId: documentId,
          principalType: principal.type,
          principalId: grant.principalId,
          permission,
          createdBy,
        };
      }),
    );
    if (rows.length > 0) await manager.getRepository(ResourceAclEntity).save(rows);
  }

  async replaceResourceReadAcl(
    manager: EntityManager,
    tenantId: string,
    resourceType: 'space' | 'folder',
    resourceId: string,
    principalIds: readonly string[],
    actorId: string,
  ): Promise<string[]> {
    const normalized = uniqueAccessPrincipalIds(principalIds);
    await this.validatePrincipals(tenantId, normalized, manager);
    await manager.getRepository(ResourceAclEntity).delete({
      tenantId,
      resourceType,
      resourceId,
      permission: 'documents.read',
    });
    await this.saveResourceReadAcl(
      manager,
      tenantId,
      resourceType,
      resourceId,
      normalized,
      actorId,
    );
    return normalized;
  }

  async recomputeDocumentEffectiveAcl(
    manager: EntityManager,
    document: DocumentEntity,
  ): Promise<string[]> {
    type SourceRow = {
      principal_id: string;
      resource_type: 'document' | 'space' | 'folder';
      resource_id: string;
      priority: number;
    };
    const rows = await manager.query<SourceRow[]>(
      `WITH RECURSIVE folder_ancestors AS (
         SELECT id, parent_id, 1 AS depth
         FROM knowledge_folder
         WHERE tenant_id = $1 AND id = $4
         UNION ALL
         SELECT parent.id, parent.parent_id, child.depth + 1
         FROM knowledge_folder parent
         INNER JOIN folder_ancestors child ON child.parent_id = parent.id
         WHERE parent.tenant_id = $1 AND child.depth < 20
       )
       SELECT acl.principal_id, acl.resource_type, acl.resource_id,
              CASE acl.resource_type
                WHEN 'document' THEN 0
                WHEN 'folder' THEN 10 + COALESCE(folder.depth, 20)
                ELSE 100
              END AS priority
       FROM resource_acl acl
       LEFT JOIN folder_ancestors folder ON acl.resource_type = 'folder' AND folder.id = acl.resource_id
       WHERE acl.tenant_id = $1
         AND (
           acl.permission = 'documents.read'
         )
         AND (
           (acl.resource_type = 'document' AND acl.resource_id = $2)
           OR (acl.resource_type = 'space' AND acl.resource_id = $3)
           OR (acl.resource_type = 'folder' AND folder.id IS NOT NULL)
         )
       ORDER BY priority ASC`,
      [document.tenantId, document.id, document.spaceId, document.folderId],
    );
    const byPrincipal = new Map<string, SourceRow>();
    for (const row of rows)
      if (!byPrincipal.has(row.principal_id)) byPrincipal.set(row.principal_id, row);
    if (byPrincipal.size === 0 && document.createdBy) {
      const ownerPrincipal = `user:${document.createdBy}`;
      byPrincipal.set(ownerPrincipal, {
        principal_id: ownerPrincipal,
        resource_type: 'document',
        resource_id: document.id,
        priority: 0,
      });
    }
    const sources = [...byPrincipal.values()];
    if (sources.length === 0) {
      throw new BadRequestException({
        code: 'DOCUMENT_WITHOUT_ACCESS_PRINCIPAL',
        message: 'A document must have at least one effective access principal',
      });
    }
    await manager.getRepository(DocumentEffectivePrincipalEntity).delete({
      tenantId: document.tenantId,
      documentId: document.id,
    });
    await manager.getRepository(DocumentEffectivePrincipalEntity).save(
      sources.map((source) => ({
        id: randomUUID(),
        tenantId: document.tenantId,
        documentId: document.id,
        principalId: source.principal_id,
        permission: 'documents.read' as const,
        sourceResourceType: source.resource_type,
        sourceResourceId: source.resource_id,
      })),
    );
    const principalIds = sources.map((source) => source.principal_id);
    document.accessPrincipalIds = principalIds;
    await manager
      .getRepository(DocumentChunkEntity)
      .createQueryBuilder()
      .update()
      .set({ principalIds })
      .where('tenant_id = :tenantId AND document_id = :documentId', {
        tenantId: document.tenantId,
        documentId: document.id,
      })
      .execute();
    return principalIds;
  }

  async createAclProjectionIntent(manager: EntityManager, document: DocumentEntity): Promise<void> {
    await manager.getRepository(OutboxEventEntity).save({
      id: randomUUID(),
      tenantId: document.tenantId,
      aggregateType: 'document',
      aggregateId: document.id,
      eventType: 'document.acl.changed',
      deduplicationKey: `document-acl:${document.id}:${document.aclVersion}`,
      payload: {
        tenantId: document.tenantId,
        documentId: document.id,
        aclVersion: document.aclVersion,
        requestedAt: new Date().toISOString(),
      },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedAt: null,
      publishedAt: null,
      lastError: null,
    });
  }

  async recordAudit(
    manager: EntityManager,
    auth: AuthContext,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await manager.getRepository(AuditEventEntity).save({
      id: randomUUID(),
      tenantId: auth.tenantId,
      actorId: auth.userId,
      action,
      resourceType,
      resourceId,
      metadata,
    });
  }

  async validatePrincipals(
    tenantId: string,
    principalIds: readonly string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    const byType = new Map<string, string[]>();
    for (const principalId of principalIds) {
      const principal = parseAccessPrincipalId(principalId);
      if (!principal) throw new BadRequestException('Invalid access principal');
      const values = byType.get(principal.type) ?? [];
      values.push(principal.id);
      byType.set(principal.type, values);
    }
    const tenantIds = byType.get('tenant') ?? [];
    if (tenantIds.some((id) => id !== tenantId)) this.invalidPrincipal();
    await Promise.all([
      this.requireMembers(tenantId, byType.get('user') ?? [], manager),
      this.requireRoles(tenantId, byType.get('role') ?? [], manager),
      this.requireDepartments(tenantId, byType.get('department') ?? [], manager),
    ]);
  }

  private async requireMembers(
    tenantId: string,
    ids: readonly string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (ids.length === 0) return;
    const count = await manager.getRepository(AppUserEntity).countBy({
      tenantId,
      id: In([...new Set(ids)]),
      status: 'active',
    });
    if (count !== new Set(ids).size) this.invalidPrincipal();
  }

  private async requireRoles(
    tenantId: string,
    ids: readonly string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (ids.length === 0) return;
    const count = await manager.getRepository(AccessRoleEntity).countBy({
      tenantId,
      id: In([...new Set(ids)]),
    });
    if (count !== new Set(ids).size) this.invalidPrincipal();
  }

  private async requireDepartments(
    tenantId: string,
    ids: readonly string[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (ids.length === 0) return;
    const count = await manager.getRepository(DepartmentEntity).countBy({
      tenantId,
      id: In([...new Set(ids)]),
    });
    if (count !== new Set(ids).size) this.invalidPrincipal();
  }

  private invalidPrincipal(): never {
    throw new BadRequestException({
      code: 'INVALID_ACCESS_PRINCIPAL',
      message: 'Every access principal must exist in the current tenant',
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

const tenantPermissionKeySet = new Set<AccessPermissionKey>(tenantAccessPermissionKeys);

function isTenantPermissionKey(key: AccessPermissionKey): key is TenantAccessPermissionKey {
  return tenantPermissionKeySet.has(key);
}

function normalizeDocumentAclGrants(grants: readonly DocumentAclGrant[]): DocumentAclGrant[] {
  const permissionsByPrincipal = new Map<string, Set<DocumentResourcePermissionKey>>();
  for (const grant of grants) {
    const principalId = uniqueAccessPrincipalIds([grant.principalId])[0];
    if (!principalId) continue;
    const permissions = permissionsByPrincipal.get(principalId) ?? new Set();
    for (const permission of grant.permissions) permissions.add(permission);
    permissionsByPrincipal.set(principalId, permissions);
  }
  return [...permissionsByPrincipal]
    .map(([principalId, permissions]) => ({
      principalId,
      permissions: [...permissions].sort(),
    }))
    .sort((left, right) => left.principalId.localeCompare(right.principalId));
}

function groupDocumentAclGrants(rows: ResourceAclEntity[]): DocumentAclGrant[] {
  return normalizeDocumentAclGrants(
    rows.map((row) => ({
      principalId: row.principalId,
      permissions: [row.permission as DocumentResourcePermissionKey],
    })),
  );
}
