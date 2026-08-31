import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DOCUMENT_INGESTION_QUEUE,
  MAX_DOCUMENT_INGESTION_ATTEMPTS,
  documentIngestionQueueJobId,
  type DocumentIngestionJob,
  type EnqueueIngestionJobResponse,
  type IngestionCommandResponse,
} from '@knowledge-base/contracts';
import {
  DocumentEntity,
  DocumentVersionEntity,
  IngestionJobEntity,
  OutboxEventEntity,
} from '@knowledge-base/database';
import { assertIngestionTransition, canTransitionIngestionStatus } from '@knowledge-base/domain';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { OutboxDispatcherService } from './outbox-dispatcher.service';

@Injectable()
export class IngestionService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectQueue(DOCUMENT_INGESTION_QUEUE) private readonly queue: Queue<DocumentIngestionJob>,
    @InjectRepository(IngestionJobEntity)
    private readonly jobRepository: Repository<IngestionJobEntity>,
    @Inject(OutboxDispatcherService)
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  async createInitialIntent(
    manager: EntityManager,
    version: DocumentVersionEntity,
  ): Promise<EnqueueIngestionJobResponse> {
    const jobs = manager.getRepository(IngestionJobEntity);
    let job = await jobs.findOne({ where: { documentVersionId: version.id } });
    if (job) {
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new BadRequestException({
          code: 'INGESTION_NOT_RETRYABLE_FROM_COMPLETE',
          message: 'Use the retry endpoint for a failed ingestion job',
        });
      }
      return { jobId: job.id, status: 'queued' };
    }

    job = jobs.create({
      id: version.id,
      tenantId: version.tenantId,
      documentId: version.documentId,
      documentVersionId: version.id,
      status: 'queued',
      progress: 0,
      attempts: 0,
      generation: 1,
      maxAttempts: MAX_DOCUMENT_INGESTION_ATTEMPTS,
      queueJobId: null,
      errorMessage: null,
      completedAt: null,
      cancellationRequestedAt: null,
      deadLetteredAt: null,
    });
    await jobs.save(job);
    await this.createIngestionOutbox(manager, version, job.generation);
    return { jobId: job.id, status: 'queued' };
  }

  async retry(tenantId: string, jobId: string): Promise<IngestionCommandResponse> {
    const response = await this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(IngestionJobEntity);
      const job = await jobs.findOne({
        where: { id: jobId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) throw new NotFoundException(`Ingestion job ${jobId} not found`);
      if (job.status !== 'failed') {
        throw new BadRequestException({
          code: 'INGESTION_NOT_FAILED',
          message: 'Only a failed ingestion job can be retried',
        });
      }

      const version = await manager.getRepository(DocumentVersionEntity).findOne({
        where: { id: job.documentVersionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!version)
        throw new NotFoundException(`Document version ${job.documentVersionId} not found`);
      assertIngestionTransition(version.ingestionStatus, 'retrying');
      version.ingestionStatus = 'retrying';
      version.errorCode = null;
      version.errorMessage = null;
      await manager.getRepository(DocumentVersionEntity).save(version);

      job.generation += 1;
      job.status = 'queued';
      job.progress = 0;
      job.attempts = 0;
      job.queueJobId = null;
      job.errorMessage = null;
      job.completedAt = null;
      job.cancellationRequestedAt = null;
      job.deadLetteredAt = null;
      await jobs.save(job);
      await this.createIngestionOutbox(manager, version, job.generation);
      return { jobId: job.id, status: 'queued' as const };
    });
    void this.dispatcher.kick();
    return response;
  }

  async cancel(tenantId: string, jobId: string): Promise<IngestionCommandResponse> {
    const queueJobId = await this.dataSource.transaction(async (manager) => {
      const jobs = manager.getRepository(IngestionJobEntity);
      const job = await jobs.findOne({
        where: { id: jobId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!job) throw new NotFoundException(`Ingestion job ${jobId} not found`);
      if (job.status === 'completed' || job.status === 'failed') {
        throw new BadRequestException({
          code: 'INGESTION_ALREADY_FINISHED',
          message: 'A completed or failed ingestion job cannot be cancelled',
        });
      }
      if (job.status === 'cancelled') return job.queueJobId;

      const version = await manager.getRepository(DocumentVersionEntity).findOne({
        where: { id: job.documentVersionId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!version)
        throw new NotFoundException(`Document version ${job.documentVersionId} not found`);
      if (canTransitionIngestionStatus(version.ingestionStatus, 'cancelled')) {
        version.ingestionStatus = 'cancelled';
        version.errorCode = 'INGESTION_CANCELLED';
        version.errorMessage = 'Document ingestion was cancelled';
        await manager.getRepository(DocumentVersionEntity).save(version);
      }

      const now = new Date();
      job.status = 'cancelled';
      job.cancellationRequestedAt = now;
      job.completedAt = now;
      await jobs.save(job);
      await manager
        .getRepository(OutboxEventEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'cancelled', lockedAt: null })
        .where('aggregate_id = :versionId', { versionId: job.documentVersionId })
        .andWhere('event_type = :eventType', { eventType: 'document.ingestion.requested' })
        .andWhere('status IN (:...statuses)', { statuses: ['pending', 'processing'] })
        .execute();
      return job.queueJobId ?? documentIngestionQueueJobId(job.documentVersionId, job.generation);
    });

    if (queueJobId) {
      const queueJob = await this.queue.getJob(queueJobId);
      if (queueJob && (await queueJob.getState()) !== 'active') await queueJob.remove();
    }
    return { jobId, status: 'cancelled' };
  }

  async createCleanupIntent(manager: EntityManager, document: DocumentEntity): Promise<void> {
    const repository = manager.getRepository(OutboxEventEntity);
    const deduplicationKey = `document-cleanup:${document.id}`;
    if (await repository.findOne({ where: { deduplicationKey } })) return;
    await repository.save(
      repository.create({
        id: randomUUID(),
        tenantId: document.tenantId,
        aggregateType: 'document',
        aggregateId: document.id,
        eventType: 'document.cleanup.requested',
        deduplicationKey,
        payload: {
          tenantId: document.tenantId,
          documentId: document.id,
          requestedAt: new Date().toISOString(),
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        publishedAt: null,
        lastError: null,
      }),
    );
  }

  dispatchPending(): void {
    void this.dispatcher.kick();
  }

  async findOne(tenantId: string, jobId: string): Promise<IngestionJobEntity> {
    const job = await this.jobRepository.findOne({ where: { id: jobId, tenantId } });
    if (!job) throw new NotFoundException(`Ingestion job ${jobId} not found`);
    return job;
  }

  async checkConnection(): Promise<void> {
    await this.queue.getJobCounts('waiting');
  }

  private async createIngestionOutbox(
    manager: EntityManager,
    version: DocumentVersionEntity,
    generation: number,
  ): Promise<void> {
    const repository = manager.getRepository(OutboxEventEntity);
    const deduplicationKey = `document-ingestion:${version.id}:${generation}`;
    if (await repository.findOne({ where: { deduplicationKey } })) return;
    await repository.save(
      repository.create({
        id: randomUUID(),
        tenantId: version.tenantId,
        aggregateType: 'document_version',
        aggregateId: version.id,
        eventType: 'document.ingestion.requested',
        deduplicationKey,
        payload: buildIngestionJob(version, generation),
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        publishedAt: null,
        lastError: null,
      }),
    );
  }
}

function buildIngestionJob(
  version: DocumentVersionEntity,
  generation: number,
): DocumentIngestionJob {
  return {
    tenantId: version.tenantId,
    documentId: version.documentId,
    documentVersionId: version.id,
    sourceBucket: version.sourceBucket,
    sourceObjectKey: version.sourceObjectKey,
    sourceFilename: version.sourceFilename,
    mimeType: version.mimeType,
    sha256: version.sha256,
    generation,
    requestedAt: new Date().toISOString(),
  };
}
