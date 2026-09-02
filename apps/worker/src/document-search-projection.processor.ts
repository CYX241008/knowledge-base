import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DOCUMENT_SEARCH_PROJECTION_QUEUE,
  DocumentSearchProjectionJobSchema,
  type DocumentSearchProjectionJob,
} from '@knowledge-base/contracts';
import { DocumentEntity } from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { SearchProjectionService } from './search-projection.service';

@Processor(DOCUMENT_SEARCH_PROJECTION_QUEUE)
export class DocumentSearchProjectionProcessor extends WorkerHost {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @Inject(SearchProjectionService)
    private readonly searchProjection: SearchProjectionService,
  ) {
    super();
  }

  async process(
    job: Job<DocumentSearchProjectionJob>,
  ): Promise<{ status: 'projected' | 'missing' | 'not-published'; chunks: number }> {
    const data = DocumentSearchProjectionJobSchema.parse(job.data);
    const document = await this.documentRepository.findOneBy({
      id: data.documentId,
      tenantId: data.tenantId,
    });
    if (!document || document.deletedAt) return { status: 'missing', chunks: 0 };
    if (document.searchProjectionVersion < data.projectionVersion) {
      throw new Error(
        `Document search projection version ${document.searchProjectionVersion} is behind job ${data.projectionVersion}`,
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
    logEvent('document.search_projected', {
      jobId: job.id,
      documentId: document.id,
      reason: data.reason,
      requestedProjectionVersion: data.projectionVersion,
      projectedProjectionVersion: document.searchProjectionVersion,
      chunks,
    });
    return { status: 'projected', chunks };
  }
}
