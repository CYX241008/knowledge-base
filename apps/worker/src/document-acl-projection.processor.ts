import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DOCUMENT_ACL_PROJECTION_QUEUE,
  DocumentAclProjectionJobSchema,
  type DocumentAclProjectionJob,
} from '@knowledge-base/contracts';
import { DocumentEntity } from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { SearchProjectionService } from './search-projection.service';

@Processor(DOCUMENT_ACL_PROJECTION_QUEUE)
export class DocumentAclProjectionProcessor extends WorkerHost {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @Inject(SearchProjectionService)
    private readonly searchProjection: SearchProjectionService,
  ) {
    super();
  }

  async process(
    job: Job<DocumentAclProjectionJob>,
  ): Promise<{ status: 'projected' | 'missing' | 'not-published'; chunks: number }> {
    const data = DocumentAclProjectionJobSchema.parse(job.data);
    const document = await this.documentRepository.findOneBy({
      id: data.documentId,
      tenantId: data.tenantId,
    });
    if (!document || document.deletedAt) return { status: 'missing', chunks: 0 };
    if (document.aclVersion < data.aclVersion) {
      throw new Error(
        `Document ACL version ${document.aclVersion} is behind job ${data.aclVersion}`,
      );
    }
    if (document.status !== 'published' || !document.currentReadyVersionId) {
      await this.searchProjection.deleteKeywordDocument(document.tenantId, document.id);
      return { status: 'not-published', chunks: 0 };
    }

    const chunks = await this.searchProjection.indexKeywords(
      document,
      document.currentReadyVersionId,
    );
    logEvent('document.acl_projected', {
      jobId: job.id,
      documentId: document.id,
      requestedAclVersion: data.aclVersion,
      projectedAclVersion: document.aclVersion,
      chunks,
    });
    return { status: 'projected', chunks };
  }
}
