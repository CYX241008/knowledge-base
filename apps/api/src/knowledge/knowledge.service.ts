import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type {
  CreateKnowledgeFolderRequest,
  CreateKnowledgeSpaceRequest,
  CreateKnowledgeTagRequest,
  KnowledgeOverviewResponse,
  MoveDocumentRequest,
  UpdateKnowledgeFolderRequest,
  UpdateKnowledgeSpaceRequest,
  UpdateKnowledgeTagRequest,
} from '@knowledge-base/contracts';
import {
  DocumentEntity,
  DocumentTagEntity,
  KnowledgeFolderEntity,
  KnowledgeSpaceEntity,
  KnowledgeTagEntity,
  OutboxEventEntity,
  ResourceAclEntity,
} from '@knowledge-base/database';
import { principalsOverlap, uniqueAccessPrincipalIds } from '@knowledge-base/domain';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { IngestionService } from '../ingestion/ingestion.service';

@Injectable()
export class KnowledgeService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(IngestionService) private readonly ingestionService: IngestionService,
  ) {}

  async overview(auth: AuthContext): Promise<KnowledgeOverviewResponse> {
    const [spaces, folders, tags, documents, documentTags, aclRows] = await Promise.all([
      this.dataSource.getRepository(KnowledgeSpaceEntity).find({
        where: { tenantId: auth.tenantId },
        order: { name: 'ASC' },
      }),
      this.dataSource.getRepository(KnowledgeFolderEntity).find({
        where: { tenantId: auth.tenantId },
        order: { sortOrder: 'ASC', name: 'ASC' },
      }),
      this.dataSource.getRepository(KnowledgeTagEntity).find({
        where: { tenantId: auth.tenantId },
        order: { name: 'ASC' },
      }),
      this.dataSource.getRepository(DocumentEntity).find({
        where: { tenantId: auth.tenantId, deletedAt: IsNull() },
        order: { updatedAt: 'DESC' },
        take: 500,
      }),
      this.dataSource.getRepository(DocumentTagEntity).findBy({ tenantId: auth.tenantId }),
      this.dataSource.getRepository(ResourceAclEntity).find({
        where: {
          tenantId: auth.tenantId,
          resourceType: In(['space', 'folder']),
          permission: 'documents.read',
        },
      }),
    ]);
    const administrator = this.canManageKnowledge(auth);
    const directAcl = new Map<string, string[]>();
    for (const row of aclRows) {
      const key = `${row.resourceType}:${row.resourceId}`;
      directAcl.set(key, [...(directAcl.get(key) ?? []), row.principalId]);
    }
    const spacePrincipals = new Map(
      spaces.map((space) => [space.id, directAcl.get(`space:${space.id}`) ?? []]),
    );
    const folderById = new Map(folders.map((folder) => [folder.id, folder]));
    const effectiveFolderPrincipals = (folder: KnowledgeFolderEntity): string[] => {
      const values = [...(spacePrincipals.get(folder.spaceId) ?? [])];
      let current: KnowledgeFolderEntity | undefined = folder;
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        values.push(...(directAcl.get(`folder:${current.id}`) ?? []));
        current = current.parentId ? folderById.get(current.parentId) : undefined;
      }
      return [...new Set(values)];
    };
    const visibleSpaces = spaces.filter(
      (space) =>
        administrator || principalsOverlap(spacePrincipals.get(space.id) ?? [], auth.principalIds),
    );
    const visibleSpaceIds = new Set(visibleSpaces.map((space) => space.id));
    const visibleFolders = folders.filter((folder) => {
      if (!visibleSpaceIds.has(folder.spaceId)) return false;
      return (
        administrator || principalsOverlap(effectiveFolderPrincipals(folder), auth.principalIds)
      );
    });
    const visibleDocuments = documents.filter(
      (document) =>
        administrator || principalsOverlap(document.accessPrincipalIds, auth.principalIds),
    );
    const visibleDocumentIds = new Set(visibleDocuments.map((document) => document.id));

    return {
      spaces: visibleSpaces.map((space) => ({
        id: space.id,
        name: space.name,
        description: space.description,
        principalIds: uniqueAccessPrincipalIds(spacePrincipals.get(space.id) ?? []),
      })),
      folders: visibleFolders.map((folder) => ({
        id: folder.id,
        spaceId: folder.spaceId,
        parentId: folder.parentId,
        name: folder.name,
        description: folder.description,
        principalIds: uniqueAccessPrincipalIds(effectiveFolderPrincipals(folder)),
        directPrincipalIds: uniqueAccessPrincipalIds(directAcl.get(`folder:${folder.id}`) ?? []),
      })),
      tags: tags.map((tag) => ({
        id: tag.id,
        name: tag.name,
        color: tag.color,
        description: tag.description,
        documentCount: documentTags.filter(
          (item) => item.tagId === tag.id && visibleDocumentIds.has(item.documentId),
        ).length,
      })),
      documents: visibleDocuments.map((document) => ({
        id: document.id,
        title: document.title,
        status: document.status,
        spaceId: document.spaceId,
        folderId: document.folderId,
        tagIds: documentTags
          .filter((item) => item.documentId === document.id)
          .map((item) => item.tagId),
        aclVersion: document.aclVersion,
        searchProjectionVersion: document.searchProjectionVersion,
      })),
    };
  }

  async createSpace(auth: AuthContext, input: CreateKnowledgeSpaceRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const id = randomUUID();
    const principalIds = uniqueAccessPrincipalIds(input.principalIds);
    await this.accessControl.validatePrincipals(auth.tenantId, principalIds);
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeSpaceEntity).save({
          id,
          tenantId: auth.tenantId,
          name: input.name,
          description: input.description ?? null,
          createdBy: auth.userId,
        });
        await this.accessControl.saveResourceReadAcl(
          manager,
          auth.tenantId,
          'space',
          id,
          principalIds,
          auth.userId,
        );
        await this.accessControl.recordAudit(manager, auth, 'space.created', 'space', id, {
          name: input.name,
          principalIds,
        });
      });
    } catch (error) {
      this.rethrowUnique(error, 'SPACE_NAME_EXISTS', 'A knowledge space with this name exists');
    }
    return { spaceId: id };
  }

  async updateSpace(auth: AuthContext, spaceId: string, input: UpdateKnowledgeSpaceRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const space = await this.requireSpace(auth.tenantId, spaceId);
    if (input.name !== undefined) space.name = input.name;
    if (input.description !== undefined) space.description = input.description;
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeSpaceEntity).save(space);
        await this.accessControl.recordAudit(
          manager,
          auth,
          'space.updated',
          'space',
          spaceId,
          input,
        );
      });
    } catch (error) {
      this.rethrowUnique(error, 'SPACE_NAME_EXISTS', 'A knowledge space with this name exists');
    }
    return { spaceId };
  }

  async deleteSpace(auth: AuthContext, spaceId: string) {
    this.accessControl.assertKnowledgeAdministration(auth);
    await this.requireSpace(auth.tenantId, spaceId);
    const documents = await this.dataSource.getRepository(DocumentEntity).countBy({
      tenantId: auth.tenantId,
      spaceId,
    });
    if (documents > 0) {
      throw new ConflictException({
        code: 'SPACE_NOT_EMPTY',
        message: 'Move documents out of the space before deleting it',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      const folders = await manager.getRepository(KnowledgeFolderEntity).findBy({
        tenantId: auth.tenantId,
        spaceId,
      });
      await manager.getRepository(ResourceAclEntity).delete({
        tenantId: auth.tenantId,
        resourceType: 'space',
        resourceId: spaceId,
      });
      if (folders.length > 0) {
        await manager.getRepository(ResourceAclEntity).delete({
          tenantId: auth.tenantId,
          resourceType: 'folder',
          resourceId: In(folders.map((folder) => folder.id)),
        });
      }
      await manager
        .getRepository(KnowledgeSpaceEntity)
        .delete({ id: spaceId, tenantId: auth.tenantId });
      await this.accessControl.recordAudit(manager, auth, 'space.deleted', 'space', spaceId);
    });
    return { spaceId, deleted: true as const };
  }

  async replaceSpaceAcl(auth: AuthContext, spaceId: string, principalIds: string[]) {
    this.accessControl.assertKnowledgeAdministration(auth);
    await this.requireSpace(auth.tenantId, spaceId);
    const response = await this.dataSource.transaction(async (manager) => {
      const normalized = await this.accessControl.replaceResourceReadAcl(
        manager,
        auth.tenantId,
        'space',
        spaceId,
        principalIds,
        auth.userId,
      );
      const updated = await this.recomputeDocuments(
        manager,
        await manager.getRepository(DocumentEntity).find({
          where: { tenantId: auth.tenantId, spaceId, deletedAt: IsNull() },
        }),
      );
      await this.accessControl.recordAudit(manager, auth, 'space.acl.replaced', 'space', spaceId, {
        principalIds: normalized,
        documentsUpdated: updated,
      });
      return { spaceId, principalIds: normalized, documentsUpdated: updated };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async createFolder(auth: AuthContext, input: CreateKnowledgeFolderRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    await this.validateLocation(auth.tenantId, input.spaceId, input.parentId ?? null);
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeFolderEntity).save({
          id,
          tenantId: auth.tenantId,
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          name: input.name,
          description: input.description ?? null,
          sortOrder: 0,
          createdBy: auth.userId,
        });
        await this.accessControl.recordAudit(manager, auth, 'folder.created', 'folder', id, {
          spaceId: input.spaceId,
          parentId: input.parentId ?? null,
          name: input.name,
        });
      });
    } catch (error) {
      this.rethrowUnique(error, 'FOLDER_NAME_EXISTS', 'A sibling folder with this name exists');
    }
    return { folderId: id };
  }

  async updateFolder(auth: AuthContext, folderId: string, input: UpdateKnowledgeFolderRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const folder = await this.requireFolder(auth.tenantId, folderId);
    const parentChanged = input.parentId !== undefined && input.parentId !== folder.parentId;
    if (input.parentId !== undefined) {
      if (input.parentId) {
        const parent = await this.requireFolder(auth.tenantId, input.parentId);
        if (parent.spaceId !== folder.spaceId) throw this.invalidLocation();
        const descendants = await this.descendantFolderIds(auth.tenantId, folder.id);
        if (parent.id === folder.id || descendants.includes(parent.id)) {
          throw new ConflictException({
            code: 'FOLDER_CYCLE',
            message: 'A folder cannot be moved into one of its descendants',
          });
        }
      }
      folder.parentId = input.parentId;
    }
    if (input.name !== undefined) folder.name = input.name;
    if (input.description !== undefined) folder.description = input.description;
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeFolderEntity).save(folder);
        let documentsUpdated = 0;
        if (parentChanged) {
          const affectedFolderIds = [
            folder.id,
            ...(await this.descendantFolderIds(auth.tenantId, folder.id, manager)),
          ];
          const documents = await manager.getRepository(DocumentEntity).find({
            where: {
              tenantId: auth.tenantId,
              folderId: In(affectedFolderIds),
              deletedAt: IsNull(),
            },
          });
          documentsUpdated = await this.recomputeDocuments(manager, documents);
        }
        await this.accessControl.recordAudit(manager, auth, 'folder.updated', 'folder', folder.id, {
          ...input,
          documentsUpdated,
        });
      });
    } catch (error) {
      this.rethrowUnique(error, 'FOLDER_NAME_EXISTS', 'A sibling folder with this name exists');
    }
    if (parentChanged) this.ingestionService.dispatchPending();
    return { folderId };
  }

  async deleteFolder(auth: AuthContext, folderId: string) {
    this.accessControl.assertKnowledgeAdministration(auth);
    await this.requireFolder(auth.tenantId, folderId);
    const [children, documents] = await Promise.all([
      this.dataSource.getRepository(KnowledgeFolderEntity).countBy({
        tenantId: auth.tenantId,
        parentId: folderId,
      }),
      this.dataSource.getRepository(DocumentEntity).countBy({
        tenantId: auth.tenantId,
        folderId,
      }),
    ]);
    if (children + documents > 0) {
      throw new ConflictException({
        code: 'FOLDER_NOT_EMPTY',
        message: 'Move child folders and documents before deleting this folder',
      });
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ResourceAclEntity).delete({
        tenantId: auth.tenantId,
        resourceType: 'folder',
        resourceId: folderId,
      });
      await manager
        .getRepository(KnowledgeFolderEntity)
        .delete({ id: folderId, tenantId: auth.tenantId });
      await this.accessControl.recordAudit(manager, auth, 'folder.deleted', 'folder', folderId);
    });
    return { folderId, deleted: true as const };
  }

  async replaceFolderAcl(auth: AuthContext, folderId: string, principalIds: string[]) {
    this.accessControl.assertKnowledgeAdministration(auth);
    await this.requireFolder(auth.tenantId, folderId);
    const response = await this.dataSource.transaction(async (manager) => {
      const normalized = await this.accessControl.replaceResourceReadAcl(
        manager,
        auth.tenantId,
        'folder',
        folderId,
        principalIds,
        auth.userId,
      );
      const folderIds = [
        folderId,
        ...(await this.descendantFolderIds(auth.tenantId, folderId, manager)),
      ];
      const documents = await manager.getRepository(DocumentEntity).find({
        where: {
          tenantId: auth.tenantId,
          folderId: In(folderIds),
          deletedAt: IsNull(),
        },
      });
      const updated = await this.recomputeDocuments(manager, documents);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'folder.acl.replaced',
        'folder',
        folderId,
        {
          principalIds: normalized,
          documentsUpdated: updated,
        },
      );
      return { folderId, principalIds: normalized, documentsUpdated: updated };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async createTag(auth: AuthContext, input: CreateKnowledgeTagRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const id = randomUUID();
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeTagEntity).save({
          id,
          tenantId: auth.tenantId,
          name: input.name,
          color: input.color.toLowerCase(),
          description: input.description ?? null,
          createdBy: auth.userId,
        });
        await this.accessControl.recordAudit(manager, auth, 'tag.created', 'tag', id, {
          name: input.name,
          color: input.color.toLowerCase(),
        });
      });
    } catch (error) {
      this.rethrowUnique(error, 'TAG_NAME_EXISTS', 'A tag with this name exists');
    }
    return { tagId: id };
  }

  async deleteTag(auth: AuthContext, tagId: string) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const tag = await this.dataSource.getRepository(KnowledgeTagEntity).findOneBy({
      id: tagId,
      tenantId: auth.tenantId,
    });
    if (!tag) throw new NotFoundException(`Tag ${tagId} not found`);
    const affected = await this.dataSource.getRepository(DocumentTagEntity).findBy({
      tenantId: auth.tenantId,
      tagId,
    });
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(KnowledgeTagEntity).remove(tag);
      for (const documentId of [...new Set(affected.map((item) => item.documentId))]) {
        const document = await manager
          .getRepository(DocumentEntity)
          .findOneBy({ id: documentId, tenantId: auth.tenantId });
        if (document) await this.touchSearchProjection(manager, document, 'tags');
      }
      await this.accessControl.recordAudit(manager, auth, 'tag.deleted', 'tag', tagId, {
        documentsUpdated: affected.length,
      });
    });
    this.ingestionService.dispatchPending();
    return { tagId, deleted: true as const };
  }

  async updateTag(auth: AuthContext, tagId: string, input: UpdateKnowledgeTagRequest) {
    this.accessControl.assertKnowledgeAdministration(auth);
    const repository = this.dataSource.getRepository(KnowledgeTagEntity);
    const tag = await repository.findOneBy({ id: tagId, tenantId: auth.tenantId });
    if (!tag) throw new NotFoundException(`Tag ${tagId} not found`);
    if (input.name !== undefined) tag.name = input.name;
    if (input.color !== undefined) tag.color = input.color.toLowerCase();
    if (input.description !== undefined) tag.description = input.description;
    try {
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(KnowledgeTagEntity).save(tag);
        await this.accessControl.recordAudit(manager, auth, 'tag.updated', 'tag', tagId, input);
      });
    } catch (error) {
      this.rethrowUnique(error, 'TAG_NAME_EXISTS', 'A tag with this name exists');
    }
    return { tagId };
  }

  async moveDocument(auth: AuthContext, documentId: string, input: MoveDocumentRequest) {
    await this.accessControl.assertDocumentManage(auth, documentId);
    await this.validateLocation(auth.tenantId, input.spaceId, input.folderId);
    const response = await this.dataSource.transaction(async (manager) => {
      const document = await manager.getRepository(DocumentEntity).findOne({
        where: { id: documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found`);
      document.spaceId = input.spaceId;
      document.folderId = input.folderId;
      document.aclVersion += 1;
      document.updatedBy = auth.userId;
      const principalIds = await this.accessControl.recomputeDocumentEffectiveAcl(
        manager,
        document,
      );
      await manager.getRepository(DocumentEntity).save(document);
      await this.accessControl.createAclProjectionIntent(manager, document);
      await this.touchSearchProjection(manager, document, 'organization');
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.moved',
        'document',
        document.id,
        {
          spaceId: input.spaceId,
          folderId: input.folderId,
        },
      );
      return { documentId, spaceId: input.spaceId, folderId: input.folderId, principalIds };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async replaceDocumentTags(auth: AuthContext, documentId: string, tagIds: string[]) {
    await this.accessControl.assertDocumentManage(auth, documentId);
    const uniqueTagIds = [...new Set(tagIds)];
    if (uniqueTagIds.length > 0) {
      const count = await this.dataSource.getRepository(KnowledgeTagEntity).countBy({
        tenantId: auth.tenantId,
        id: In(uniqueTagIds),
      });
      if (count !== uniqueTagIds.length)
        throw new NotFoundException('One or more tags were not found');
    }
    const response = await this.dataSource.transaction(async (manager) => {
      const document = await manager.getRepository(DocumentEntity).findOne({
        where: { id: documentId, tenantId: auth.tenantId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found`);
      await manager
        .getRepository(DocumentTagEntity)
        .delete({ documentId, tenantId: auth.tenantId });
      if (uniqueTagIds.length > 0) {
        await manager
          .getRepository(DocumentTagEntity)
          .save(uniqueTagIds.map((tagId) => ({ documentId, tagId, tenantId: auth.tenantId })));
      }
      await this.touchSearchProjection(manager, document, 'tags');
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.tags.replaced',
        'document',
        documentId,
        {
          tagIds: uniqueTagIds,
        },
      );
      return { documentId, tagIds: uniqueTagIds, projectionStatus: 'queued' as const };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async validateLocation(
    tenantId: string,
    spaceId: string | null | undefined,
    folderId: string | null | undefined,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (!spaceId) {
      if (folderId) throw this.invalidLocation();
      return;
    }
    const space = await manager
      .getRepository(KnowledgeSpaceEntity)
      .findOneBy({ id: spaceId, tenantId });
    if (!space) throw this.invalidLocation();
    if (folderId) {
      const folder = await manager.getRepository(KnowledgeFolderEntity).findOneBy({
        id: folderId,
        tenantId,
        spaceId,
      });
      if (!folder) throw this.invalidLocation();
    }
  }

  private async recomputeDocuments(
    manager: EntityManager,
    documents: DocumentEntity[],
  ): Promise<number> {
    for (const document of documents) {
      document.aclVersion += 1;
      await this.accessControl.recomputeDocumentEffectiveAcl(manager, document);
      await manager.getRepository(DocumentEntity).save(document);
      await this.accessControl.createAclProjectionIntent(manager, document);
    }
    return documents.length;
  }

  private async touchSearchProjection(
    manager: EntityManager,
    document: DocumentEntity,
    reason: 'organization' | 'tags',
  ): Promise<void> {
    document.searchProjectionVersion += 1;
    await manager.getRepository(DocumentEntity).save(document);
    await manager.getRepository(OutboxEventEntity).save({
      id: randomUUID(),
      tenantId: document.tenantId,
      aggregateType: 'document',
      aggregateId: document.id,
      eventType: 'document.search-projection.requested',
      deduplicationKey: `document-search:${document.id}:${document.searchProjectionVersion}`,
      payload: {
        tenantId: document.tenantId,
        documentId: document.id,
        projectionVersion: document.searchProjectionVersion,
        reason,
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

  private async descendantFolderIds(
    tenantId: string,
    folderId: string,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<string[]> {
    const rows = await manager.query<Array<{ id: string }>>(
      `WITH RECURSIVE descendants AS (
         SELECT id FROM knowledge_folder WHERE tenant_id = $1 AND parent_id = $2
         UNION ALL
         SELECT child.id FROM knowledge_folder child
         INNER JOIN descendants parent ON child.parent_id = parent.id
         WHERE child.tenant_id = $1
       ) SELECT id FROM descendants`,
      [tenantId, folderId],
    );
    return rows.map((row) => row.id);
  }

  private requireSpace(tenantId: string, spaceId: string) {
    return this.dataSource
      .getRepository(KnowledgeSpaceEntity)
      .findOneBy({ id: spaceId, tenantId })
      .then((space) => {
        if (!space) throw new NotFoundException(`Knowledge space ${spaceId} not found`);
        return space;
      });
  }

  private requireFolder(tenantId: string, folderId: string) {
    return this.dataSource
      .getRepository(KnowledgeFolderEntity)
      .findOneBy({ id: folderId, tenantId })
      .then((folder) => {
        if (!folder) throw new NotFoundException(`Knowledge folder ${folderId} not found`);
        return folder;
      });
  }

  private canManageKnowledge(auth: AuthContext): boolean {
    return (
      auth.principalIds.includes('permission:knowledge.manage') ||
      auth.principalIds.includes('permission:access.manage')
    );
  }

  private invalidLocation(): ConflictException {
    return new ConflictException({
      code: 'INVALID_KNOWLEDGE_LOCATION',
      message: 'The selected space and folder do not form a valid tenant location',
    });
  }

  private rethrowUnique(error: unknown, code: string, message: string): never {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new ConflictException({ code, message });
    }
    throw error;
  }
}
