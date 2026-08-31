import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DOCUMENT_CLEANUP_JOB,
  DOCUMENT_CLEANUP_QUEUE,
  DOCUMENT_ACL_PROJECTION_JOB,
  DOCUMENT_ACL_PROJECTION_QUEUE,
  DOCUMENT_INGESTION_JOB,
  DOCUMENT_INGESTION_QUEUE,
  DOCUMENT_SEARCH_PROJECTION_JOB,
  DOCUMENT_SEARCH_PROJECTION_QUEUE,
  DocumentCleanupJobSchema,
  DocumentAclProjectionJobSchema,
  DocumentIngestionJobSchema,
  DocumentSearchProjectionJobSchema,
  MAX_DOCUMENT_INGESTION_ATTEMPTS,
  documentCleanupQueueJobId,
  documentAclProjectionQueueJobId,
  documentIngestionQueueJobId,
  documentSearchProjectionQueueJobId,
  type DocumentCleanupJob,
  type DocumentAclProjectionJob,
  type DocumentIngestionJob,
  type DocumentSearchProjectionJob,
} from '@knowledge-base/contracts';
import type { ServerEnv } from '@knowledge-base/config';
import { IngestionJobEntity, OutboxEventEntity } from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';

const OUTBOX_BATCH_SIZE = 20;
const OUTBOX_MAX_ATTEMPTS = 10;
const OUTBOX_LOCK_TIMEOUT_MS = 5 * 60 * 1_000;

@Injectable()
export class OutboxDispatcherService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dispatching = false;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @InjectQueue(DOCUMENT_INGESTION_QUEUE)
    private readonly ingestionQueue: Queue<DocumentIngestionJob>,
    @InjectQueue(DOCUMENT_CLEANUP_QUEUE)
    private readonly cleanupQueue: Queue<DocumentCleanupJob>,
    @InjectQueue(DOCUMENT_ACL_PROJECTION_QUEUE)
    private readonly aclProjectionQueue: Queue<DocumentAclProjectionJob>,
    @InjectQueue(DOCUMENT_SEARCH_PROJECTION_QUEUE)
    private readonly searchProjectionQueue: Queue<DocumentSearchProjectionJob>,
  ) {}

  onModuleInit(): void {
    const intervalMs = this.config.getOrThrow('OUTBOX_POLL_INTERVAL_MS');
    this.timer = setInterval(() => void this.kick(), intervalMs);
    this.timer.unref?.();
    void this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async kick(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.recoverExpiredLocks();
      while (true) {
        const events = await this.claimBatch();
        if (events.length === 0) break;
        for (const event of events) await this.publish(event);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async recoverExpiredLocks(): Promise<void> {
    const expiredAt = new Date(Date.now() - OUTBOX_LOCK_TIMEOUT_MS);
    await this.dataSource
      .getRepository(OutboxEventEntity)
      .createQueryBuilder()
      .update()
      .set({ status: 'pending', lockedAt: null })
      .where('status = :status', { status: 'processing' })
      .andWhere('locked_at < :expiredAt', { expiredAt })
      .execute();
  }

  private claimBatch(): Promise<OutboxEventEntity[]> {
    return this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(OutboxEventEntity);
      const events = await repository
        .createQueryBuilder('event')
        .where('event.status = :status', { status: 'pending' })
        .andWhere('event.nextAttemptAt <= :now', { now: new Date() })
        .orderBy('event.createdAt', 'ASC')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .take(OUTBOX_BATCH_SIZE)
        .getMany();
      const lockedAt = new Date();
      for (const event of events) {
        event.status = 'processing';
        event.lockedAt = lockedAt;
      }
      return repository.save(events);
    });
  }

  private async publish(event: OutboxEventEntity): Promise<void> {
    try {
      if (event.eventType === 'document.ingestion.requested') {
        const payload = DocumentIngestionJobSchema.parse(event.payload);
        const queueJobId = documentIngestionQueueJobId(
          payload.documentVersionId,
          payload.generation,
        );
        await this.ingestionQueue.add(DOCUMENT_INGESTION_JOB, payload, {
          jobId: queueJobId,
          attempts: MAX_DOCUMENT_INGESTION_ATTEMPTS,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
        await this.dataSource
          .getRepository(IngestionJobEntity)
          .update(
            { id: payload.documentVersionId, generation: payload.generation },
            { queueJobId },
          );
      } else if (event.eventType === 'document.cleanup.requested') {
        const payload = DocumentCleanupJobSchema.parse(event.payload);
        await this.cleanupQueue.add(DOCUMENT_CLEANUP_JOB, payload, {
          jobId: documentCleanupQueueJobId(payload.documentId),
          delay: 5_000,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else if (event.eventType === 'document.acl.changed') {
        const payload = DocumentAclProjectionJobSchema.parse(event.payload);
        await this.aclProjectionQueue.add(DOCUMENT_ACL_PROJECTION_JOB, payload, {
          jobId: documentAclProjectionQueueJobId(payload.documentId, payload.aclVersion),
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else if (event.eventType === 'document.search-projection.requested') {
        const payload = DocumentSearchProjectionJobSchema.parse(event.payload);
        await this.searchProjectionQueue.add(DOCUMENT_SEARCH_PROJECTION_JOB, payload, {
          jobId: documentSearchProjectionQueueJobId(payload.documentId, payload.projectionVersion),
          attempts: 5,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        });
      } else {
        throw new Error(`Unsupported outbox event type: ${String(event.eventType)}`);
      }

      await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
        status: 'published',
        attempts: event.attempts + 1,
        lockedAt: null,
        publishedAt: new Date(),
        lastError: null,
      });
    } catch (error) {
      const attempts = event.attempts + 1;
      const message = error instanceof Error ? error.message : String(error);
      await this.dataSource.getRepository(OutboxEventEntity).update(event.id, {
        status: attempts >= OUTBOX_MAX_ATTEMPTS ? 'dead' : 'pending',
        attempts,
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + outboxBackoffMs(attempts)),
        lastError: message.slice(0, 4000),
      });
      logEvent('outbox.publish_failed', {
        eventId: event.id,
        eventType: event.eventType,
        attempts,
        error: message,
      });
    }
  }
}

export function outboxBackoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}
