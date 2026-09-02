import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  CompleteDocumentUploadResponse,
  CreateDocumentUploadRequest,
  CreateDocumentUploadResponse,
  DeleteDocumentResponse,
  DocumentQuery,
  PublishDocumentVersionResponse,
} from '@knowledge-base/contracts';
import {
  DocumentAssetEntity,
  DocumentEntity,
  DocumentReviewRequestEntity,
  DocumentVersionEntity,
  IngestionJobEntity,
  OutboxEventEntity,
} from '@knowledge-base/database';
import { assertIngestionTransition, canTransitionIngestionStatus } from '@knowledge-base/domain';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { DataSource, IsNull, Repository } from 'typeorm';
import { IngestionService } from '../ingestion/ingestion.service';
import { OBJECT_STORAGE } from '../storage/storage.constants';
import { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import { KnowledgeService } from '../knowledge/knowledge.service';

const supportedExtensions = new Set(['txt', 'md', 'markdown', 'docx', 'pdf', 'xlsx', 'pptx']);

type CreateDocumentUploadCommand = Omit<CreateDocumentUploadRequest, 'tenantId'> & {
  tenantId: string;
};

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(DocumentVersionEntity)
    private readonly versionRepository: Repository<DocumentVersionEntity>,
    @InjectRepository(DocumentAssetEntity)
    private readonly assetRepository: Repository<DocumentAssetEntity>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(IngestionService) private readonly ingestionService: IngestionService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
    @Inject(KnowledgeService) private readonly knowledgeService: KnowledgeService,
  ) {}

  async createUpload(
    input: CreateDocumentUploadCommand,
    auth: AuthContext,
  ): Promise<CreateDocumentUploadResponse> {
    if (input.sizeBytes > this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES')) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: 'File exceeds the configured upload limit',
      });
    }
    const extension = extensionOf(input.sourceFilename);
    if (!supportedExtensions.has(extension)) {
      throw new BadRequestException({
        code: 'UNSUPPORTED_FILE_TYPE',
        message: 'Supported formats: TXT, Markdown, DOCX, PDF, XLSX, PPTX',
      });
    }

    await this.storage.ensureBucket();
    const documentId = input.documentId ?? randomUUID();
    const documentVersionId = randomUUID();

    const { sourceObjectKey } = await this.dataSource.transaction(async (manager) => {
      const documents = manager.getRepository(DocumentEntity);
      const versions = manager.getRepository(DocumentVersionEntity);
      let document: DocumentEntity;

      if (input.documentId) {
        const found = await documents.findOne({
          where: { id: input.documentId, tenantId: input.tenantId, deletedAt: IsNull() },
          lock: { mode: 'pessimistic_write' },
        });
        if (!found) throw new NotFoundException(`Document ${input.documentId} not found`);
        document = found;
      } else {
        await this.knowledgeService.validateLocation(
          input.tenantId,
          input.spaceId ?? null,
          input.folderId ?? null,
          manager,
        );
        document = documents.create({
          id: documentId,
          tenantId: input.tenantId,
          spaceId: input.spaceId ?? null,
          folderId: input.folderId ?? null,
          title: input.title,
          summary: null,
          status: 'draft',
          currentReadyVersionId: null,
          createdBy: input.createdBy ?? null,
          updatedBy: input.createdBy ?? null,
          accessPrincipalIds:
            input.principalIds && input.principalIds.length > 0
              ? [...new Set(input.principalIds)]
              : [input.createdBy ? `user:${input.createdBy}` : `tenant:${input.tenantId}`],
          aclVersion: 1,
          searchProjectionVersion: 1,
          deletedAt: null,
          purgedAt: null,
        });
        await documents.save(document);
        await this.accessControl.createInitialDocumentAcl(
          manager,
          document,
          input.principalIds ?? [],
          document.createdBy,
        );
      }

      const raw = await versions
        .createQueryBuilder('version')
        .select('COALESCE(MAX(version.versionNo), 0)', 'max')
        .where('version.documentId = :documentId', { documentId })
        .andWhere('version.tenantId = :tenantId', { tenantId: input.tenantId })
        .getRawOne<{ max: string }>();
      const versionNo = Number(raw?.max ?? 0) + 1;
      const sourceObjectKey = buildSourceObjectKey(
        input.tenantId,
        documentId,
        documentVersionId,
        input.sourceFilename,
      );

      await versions.save(
        versions.create({
          id: documentVersionId,
          tenantId: input.tenantId,
          documentId,
          versionNo,
          sourceBucket: this.storage.bucket,
          sourceObjectKey,
          sourceFilename: input.sourceFilename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256.toLowerCase(),
          markdownBucket: null,
          markdownObjectKey: null,
          parserName: null,
          parserVersion: null,
          ingestionStatus: 'received',
          wordCount: 0,
          errorCode: null,
          errorMessage: null,
          readyAt: null,
        }),
      );
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.version.created',
        'document',
        documentId,
        {
          documentVersionId,
          versionNo,
          newDocument: !input.documentId,
          sourceFilename: input.sourceFilename,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
        },
      );
      return { sourceObjectKey };
    });

    const signed = await this.storage.createPresignedUpload({
      key: sourceObjectKey,
      contentType: input.mimeType,
      sha256: input.sha256,
    });
    return {
      documentId,
      documentVersionId,
      uploadUrl: signed.url,
      uploadHeaders: signed.headers,
      expiresInSeconds: signed.expiresInSeconds,
    };
  }

  async completeUpload(
    auth: AuthContext,
    documentId: string,
    versionId: string,
  ): Promise<CompleteDocumentUploadResponse> {
    const tenantId = auth.tenantId;
    const version = await this.versionRepository.findOne({
      where: { id: versionId, documentId, tenantId },
    });
    if (!version) throw new NotFoundException(`Document version ${versionId} not found`);
    if (version.ingestionStatus === 'ready')
      return { documentId, documentVersionId: versionId, jobId: versionId, status: 'ready' };

    const object = await this.storage.headObject(version.sourceObjectKey).catch(() => {
      throw new BadRequestException({
        code: 'SOURCE_OBJECT_MISSING',
        message: 'Uploaded file was not found',
      });
    });
    if (object.contentLength !== version.sizeBytes) {
      throw new BadRequestException({
        code: 'FILE_SIZE_MISMATCH',
        message: 'Uploaded file size does not match',
      });
    }
    if (object.metadata.sha256?.toLowerCase() !== version.sha256.toLowerCase()) {
      throw new BadRequestException({
        code: 'FILE_CHECKSUM_MISMATCH',
        message: 'Uploaded file checksum metadata does not match',
      });
    }

    const queued = await this.dataSource.transaction(async (manager) => {
      const lockedVersion = await manager.getRepository(DocumentVersionEntity).findOne({
        where: { id: versionId, documentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedVersion) throw new NotFoundException(`Document version ${versionId} not found`);
      if (lockedVersion.ingestionStatus === 'ready') {
        return { jobId: versionId, status: 'ready' as const };
      }
      if (lockedVersion.ingestionStatus === 'received') {
        assertIngestionTransition(lockedVersion.ingestionStatus, 'stored');
        lockedVersion.ingestionStatus = 'stored';
        await manager.getRepository(DocumentVersionEntity).save(lockedVersion);
      }
      const intent = await this.ingestionService.createInitialIntent(manager, lockedVersion);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.ingestion.requested',
        'document',
        documentId,
        { documentVersionId: versionId, status: intent.status },
      );
      return intent;
    });
    this.ingestionService.dispatchPending();
    if (queued.status === 'ready') {
      return { documentId, documentVersionId: versionId, jobId: queued.jobId, status: 'ready' };
    }
    return { documentId, documentVersionId: versionId, jobId: queued.jobId, status: 'queued' };
  }

  async publishVersion(
    auth: AuthContext,
    documentId: string,
    versionId: string,
  ): Promise<PublishDocumentVersionResponse> {
    const tenantId = auth.tenantId;
    const response = await this.dataSource.transaction(async (manager) => {
      const documents = manager.getRepository(DocumentEntity);
      const document = await documents.findOne({
        where: { id: documentId, tenantId, deletedAt: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found`);
      const version = await manager.getRepository(DocumentVersionEntity).findOne({
        where: { id: versionId, documentId, tenantId },
        lock: { mode: 'pessimistic_read' },
      });
      if (!version) throw new NotFoundException(`Document version ${versionId} not found`);
      if (version.ingestionStatus !== 'ready') {
        throw new BadRequestException({
          code: 'DOCUMENT_VERSION_NOT_READY',
          message: 'Only a ready document version can be published',
        });
      }
      const pendingReview = await manager.getRepository(DocumentReviewRequestEntity).findOne({
        where: { tenantId, documentId, status: 'pending' },
        lock: { mode: 'pessimistic_read' },
      });
      if (pendingReview) {
        throw new BadRequestException({
          code: 'DOCUMENT_REVIEW_PENDING',
          message: 'A pending review must be approved or rejected before direct publication',
        });
      }
      document.currentReadyVersionId = version.id;
      document.status = 'published';
      document.updatedBy = auth.userId;
      await this.ingestionService.createSearchProjectionIntent(manager, document, 'publish');
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.version.published',
        'document',
        documentId,
        { documentVersionId: version.id, versionNo: version.versionNo },
      );
      return {
        documentId,
        documentVersionId: version.id,
        status: 'published' as const,
        projectionStatus: 'queued' as const,
      };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async deleteDocument(auth: AuthContext, documentId: string): Promise<DeleteDocumentResponse> {
    const tenantId = auth.tenantId;
    const response = await this.dataSource.transaction(async (manager) => {
      const documents = manager.getRepository(DocumentEntity);
      const document = await documents.findOne({
        where: { id: documentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found`);
      if (!document.deletedAt) {
        document.deletedAt = new Date();
        document.status = 'archived';
        document.currentReadyVersionId = null;
        await documents.save(document);
      }
      const versions = await manager.getRepository(DocumentVersionEntity).find({
        where: { documentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      for (const version of versions) {
        if (!canTransitionIngestionStatus(version.ingestionStatus, 'cancelled')) continue;
        version.ingestionStatus = 'cancelled';
        version.errorCode = 'DOCUMENT_DELETED';
        version.errorMessage = 'Document was deleted';
        await manager.getRepository(DocumentVersionEntity).save(version);
      }
      const now = new Date();
      await manager
        .getRepository(IngestionJobEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'cancelled', cancellationRequestedAt: now, completedAt: now })
        .where('document_id = :documentId', { documentId })
        .andWhere('status IN (:...statuses)', { statuses: ['queued', 'active'] })
        .execute();
      const versionIds = versions.map((item) => item.id);
      if (versionIds.length > 0) {
        await manager
          .getRepository(OutboxEventEntity)
          .createQueryBuilder()
          .update()
          .set({ status: 'cancelled', lockedAt: null })
          .where('aggregate_id IN (:...versionIds)', { versionIds })
          .andWhere('event_type = :eventType', { eventType: 'document.ingestion.requested' })
          .andWhere('status IN (:...statuses)', { statuses: ['pending', 'processing'] })
          .execute();
      }
      await this.ingestionService.createCleanupIntent(manager, document);
      await this.accessControl.recordAudit(
        manager,
        auth,
        'document.archived',
        'document',
        documentId,
        { versionCount: versions.length },
      );
      return { documentId, status: 'archived' as const };
    });
    this.ingestionService.dispatchPending();
    return response;
  }

  async findAll(
    query: DocumentQuery,
    principalIds: string[],
  ): Promise<{ items: unknown[]; total: number; page: number; pageSize: number }> {
    const qb = this.documentRepository
      .createQueryBuilder('document')
      .where('document.tenantId = :tenantId', { tenantId: query.tenantId })
      .andWhere('document.deletedAt IS NULL')
      .andWhere(
        `EXISTS (
          SELECT 1 FROM document_effective_principal effective
          WHERE effective.tenant_id = document.tenant_id
            AND effective.document_id = document.id
            AND effective.principal_id = ANY(CAST(:principalIds AS varchar[]))
        )`,
        { principalIds },
      );
    if (query.title) qb.andWhere('document.title ILIKE :title', { title: `%${query.title}%` });
    if (query.spaceId) qb.andWhere('document.spaceId = :spaceId', { spaceId: query.spaceId });
    if (query.folderId) qb.andWhere('document.folderId = :folderId', { folderId: query.folderId });
    if (query.tagIds?.length) {
      qb.andWhere(
        `document.id IN (
          SELECT tagged.document_id
          FROM document_tag tagged
          WHERE tagged.tenant_id = document.tenant_id
            AND tagged.tag_id = ANY(CAST(:tagIds AS uuid[]))
          GROUP BY tagged.document_id
          HAVING COUNT(DISTINCT tagged.tag_id) = :tagCount
        )`,
        { tagIds: query.tagIds, tagCount: query.tagIds.length },
      );
    }
    qb.orderBy('document.createdAt', 'DESC')
      .skip((query.page - 1) * query.pageSize)
      .take(query.pageSize);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async findOne(
    tenantId: string,
    documentId: string,
  ): Promise<{ document: DocumentEntity; versions: DocumentVersionEntity[] }> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId, tenantId, deletedAt: IsNull() },
    });
    if (!document) throw new NotFoundException(`Document ${documentId} not found`);
    const versions = await this.versionRepository.find({
      where: { documentId, tenantId },
      order: { versionNo: 'DESC' },
    });
    return { document, versions };
  }

  async getMarkdown(tenantId: string, documentId: string, versionId: string): Promise<string> {
    const version = await this.versionRepository.findOne({
      where: { id: versionId, documentId, tenantId },
    });
    if (!version?.markdownObjectKey)
      throw new NotFoundException(`Markdown for version ${versionId} is not ready`);
    const bytes = await this.storage.getObjectBytes(
      version.markdownObjectKey,
      this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES') * 2,
    );
    const markdown = new TextDecoder().decode(bytes);
    const assets = await this.assetRepository.find({
      where: { tenantId, documentVersionId: versionId },
      order: { ordinal: 'ASC' },
    });
    if (assets.length === 0) return markdown;

    const signedReferences = new Map<string, string>();
    await Promise.all(
      assets.map(async (asset) => {
        const reference = `knowledge-asset://${encodeURIComponent(asset.filename)}`;
        signedReferences.set(
          reference,
          await this.storage.createPresignedDownload(asset.objectKey),
        );
      }),
    );
    return markdown.replace(/knowledge-asset:\/\/[^)\s]+/g, (reference) => {
      return signedReferences.get(reference) ?? reference;
    });
  }
}

function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}

function buildSourceObjectKey(
  tenantId: string,
  documentId: string,
  versionId: string,
  filename: string,
): string {
  const safeName =
    basename(filename)
      .replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')
      .slice(0, 160) || 'document';
  return `tenants/${tenantId}/documents/${documentId}/versions/${versionId}/source/${safeName}`;
}
