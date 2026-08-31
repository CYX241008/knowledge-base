import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DOCUMENT_CLEANUP_QUEUE,
  DocumentCleanupJobSchema,
  type DocumentCleanupJob,
} from '@knowledge-base/contracts';
import {
  ChatCitationEntity,
  DocumentAssetEntity,
  DocumentChunkEntity,
  DocumentEntity,
  DocumentEffectivePrincipalEntity,
  DocumentSourceAnchorEntity,
  DocumentVersionEntity,
  ResourceAclEntity,
} from '@knowledge-base/database';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { logEvent } from '@knowledge-base/observability';
import { Job } from 'bullmq';
import { DataSource, In, Repository } from 'typeorm';
import { OBJECT_STORAGE } from './worker.constants';
import { SearchProjectionService } from './search-projection.service';

@Processor(DOCUMENT_CLEANUP_QUEUE)
export class DocumentCleanupProcessor extends WorkerHost {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(DocumentVersionEntity)
    private readonly versionRepository: Repository<DocumentVersionEntity>,
    @Inject(SearchProjectionService)
    private readonly searchProjection: SearchProjectionService,
  ) {
    super();
  }

  async process(job: Job<DocumentCleanupJob>): Promise<{ status: 'purged' | 'missing' }> {
    const data = DocumentCleanupJobSchema.parse(job.data);
    const document = await this.documentRepository.findOneBy({
      id: data.documentId,
      tenantId: data.tenantId,
    });
    if (!document) return { status: 'missing' };
    if (document.purgedAt) return { status: 'purged' };
    if (!document.deletedAt) throw new Error(`Document ${data.documentId} is not deleted`);

    const prefix = `tenants/${data.tenantId}/documents/${data.documentId}/`;
    const objects = await this.storage.listObjects(prefix);
    await Promise.all(objects.map((object) => this.storage.deleteObject(object.key)));
    await this.searchProjection.deleteKeywordDocument(data.tenantId, data.documentId);

    await this.dataSource.transaction(async (manager) => {
      const lockedDocument = await manager.getRepository(DocumentEntity).findOne({
        where: { id: data.documentId, tenantId: data.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedDocument || lockedDocument.purgedAt) return;
      const versions = await manager.getRepository(DocumentVersionEntity).find({
        where: { documentId: data.documentId, tenantId: data.tenantId },
        select: { id: true },
      });
      const versionIds = versions.map((version) => version.id);
      await manager
        .getRepository(ChatCitationEntity)
        .delete({ tenantId: data.tenantId, documentId: data.documentId });
      await manager.getRepository(DocumentEffectivePrincipalEntity).delete({
        tenantId: data.tenantId,
        documentId: data.documentId,
      });
      await manager.getRepository(ResourceAclEntity).delete({
        tenantId: data.tenantId,
        resourceType: 'document',
        resourceId: data.documentId,
      });
      if (versionIds.length > 0) {
        await manager
          .getRepository(DocumentSourceAnchorEntity)
          .delete({ documentVersionId: In(versionIds) });
        await manager
          .getRepository(DocumentAssetEntity)
          .delete({ documentVersionId: In(versionIds) });
        await manager
          .getRepository(DocumentChunkEntity)
          .delete({ documentVersionId: In(versionIds) });
      }
      lockedDocument.purgedAt = new Date();
      await manager.getRepository(DocumentEntity).save(lockedDocument);
    });

    logEvent('document.cleanup_completed', {
      jobId: job.id,
      documentId: data.documentId,
      deletedObjects: objects.length,
    });
    return { status: 'purged' };
  }
}
