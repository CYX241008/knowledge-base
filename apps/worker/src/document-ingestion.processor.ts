import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  DOCUMENT_INGESTION_QUEUE,
  DocumentIngestionJobSchema,
  type DocumentIngestionJob,
  type IngestionStatus,
} from '@knowledge-base/contracts';
import type { ServerEnv } from '@knowledge-base/config';
import {
  DocumentEntity,
  DocumentAssetEntity,
  DocumentSourceAnchorEntity,
  DocumentVersionEntity,
  IngestionJobEntity,
  IngestionStageEntity,
  type IngestionStageStatus,
} from '@knowledge-base/database';
import { assertIngestionTransition, canTransitionIngestionStatus } from '@knowledge-base/domain';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { logEvent } from '@knowledge-base/observability';
import { DocumentParserRegistry, type ParsedDocument } from '@knowledge-base/rag';
import { DataSource, Repository } from 'typeorm';
import { OBJECT_STORAGE } from './worker.constants';
import { SearchProjectionService } from './search-projection.service';

const PROCESSOR_VERSION = 'document-ingestion-v5';

class IngestionCancelledError extends Error {}
class StaleIngestionJobError extends Error {}

@Processor(DOCUMENT_INGESTION_QUEUE)
export class DocumentIngestionProcessor extends WorkerHost {
  private readonly parser = new DocumentParserRegistry();

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @InjectRepository(DocumentVersionEntity)
    private readonly versionRepository: Repository<DocumentVersionEntity>,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(DocumentSourceAnchorEntity)
    private readonly anchorRepository: Repository<DocumentSourceAnchorEntity>,
    @InjectRepository(IngestionJobEntity)
    private readonly jobRepository: Repository<IngestionJobEntity>,
    @InjectRepository(IngestionStageEntity)
    private readonly stageRepository: Repository<IngestionStageEntity>,
    @Inject(SearchProjectionService)
    private readonly searchProjection: SearchProjectionService,
  ) {
    super();
  }

  async process(
    job: Job<DocumentIngestionJob>,
  ): Promise<{ status: 'ready' | 'cancelled' | 'stale' }> {
    const data = DocumentIngestionJobSchema.parse(job.data);
    const ingestionJob = await this.jobRepository.findOneBy({ id: data.documentVersionId });
    if (!ingestionJob || ingestionJob.generation !== data.generation) return { status: 'stale' };
    if (ingestionJob.status === 'cancelled' || ingestionJob.cancellationRequestedAt)
      return { status: 'cancelled' };
    const version = await this.versionRepository.findOne({
      where: { id: data.documentVersionId, documentId: data.documentId, tenantId: data.tenantId },
    });
    if (!version) throw new Error(`Document version ${data.documentVersionId} not found`);
    if (version.ingestionStatus === 'ready') return { status: 'ready' };
    const document = await this.documentRepository.findOne({
      where: { id: data.documentId, tenantId: data.tenantId },
    });
    if (!document) throw new Error(`Document ${data.documentId} not found`);

    logEvent('ingestion.started', {
      jobId: job.id,
      documentId: data.documentId,
      versionId: data.documentVersionId,
    });
    let activeStage: IngestionStatus = 'stored';

    try {
      await this.prepareForAttempt(version, data);
      await this.updateJob(
        data.documentVersionId,
        data.generation,
        'active',
        5,
        job.attemptsMade + 1,
        null,
      );
      await job.updateProgress(5);

      activeStage = 'parsing';
      await this.transitionVersion(version, 'parsing', data);
      await this.updateStage(data.documentVersionId, activeStage, 'active', 10, null, data.sha256);
      const bytes = await this.storage.getObjectBytes(
        data.sourceObjectKey,
        this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES'),
      );
      const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
      if (sourceSha256 !== data.sha256.toLowerCase())
        throw new Error('Source object SHA-256 does not match the version');
      const parsed = await this.parser.parse({
        filename: data.sourceFilename,
        mimeType: data.mimeType,
        bytes,
      });
      await this.assertRunnable(data);
      const parsedChecksum = checksumParsedDocument(parsed);
      if (parsed.warnings.length > 0) {
        logEvent('ingestion.parser_warnings', {
          jobId: job.id,
          versionId: data.documentVersionId,
          parser: parsed.parserName,
          warnings: parsed.warnings,
        });
      }
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'completed',
        45,
        null,
        data.sha256,
        parsedChecksum,
      );
      await this.updateJob(
        data.documentVersionId,
        data.generation,
        'active',
        45,
        job.attemptsMade + 1,
        null,
      );
      await job.updateProgress(45);

      activeStage = 'normalizing';
      await this.transitionVersion(version, 'normalizing', data);
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'active',
        50,
        null,
        parsedChecksum,
      );
      const normalized = await this.persistParsedDocument(data, version, parsed);
      await this.assertRunnable(data);
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'completed',
        75,
        null,
        parsedChecksum,
        normalized.checksum,
      );
      await this.updateJob(
        data.documentVersionId,
        data.generation,
        'active',
        75,
        job.attemptsMade + 1,
        null,
      );
      await job.updateProgress(75);

      activeStage = 'chunking';
      await this.transitionVersion(version, 'chunking', data);
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'active',
        78,
        null,
        normalized.checksum,
      );
      const chunkResult = await this.searchProjection.buildChunks({
        document,
        version,
        markdown: normalized.markdown,
        anchors: parsed.anchors,
      });
      await this.assertRunnable(data);
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'completed',
        85,
        null,
        normalized.checksum,
        chunkResult.checksum,
      );
      await this.updateJob(
        data.documentVersionId,
        data.generation,
        'active',
        85,
        job.attemptsMade + 1,
        null,
      );
      await job.updateProgress(85);

      activeStage = 'indexing';
      await this.transitionVersion(version, 'indexing', data);
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'active',
        88,
        null,
        chunkResult.checksum,
      );
      await this.assertRunnable(data);
      const indexChecksum = createHash('sha256')
        .update(`${chunkResult.checksum}:pgvector:${chunkResult.count}`)
        .digest('hex');
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'completed',
        95,
        null,
        chunkResult.checksum,
        indexChecksum,
      );
      await job.updateProgress(95);

      await this.dataSource.transaction(async (manager) => {
        const lockedJob = await manager.getRepository(IngestionJobEntity).findOne({
          where: { id: data.documentVersionId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedJob || lockedJob.generation !== data.generation)
          throw new StaleIngestionJobError('A newer ingestion generation is active');
        if (lockedJob.status === 'cancelled' || lockedJob.cancellationRequestedAt)
          throw new IngestionCancelledError('Document ingestion was cancelled');

        const lockedVersion = await manager.getRepository(DocumentVersionEntity).findOne({
          where: { id: version.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lockedVersion) throw new Error(`Document version ${version.id} not found`);
        if (lockedVersion.ingestionStatus === 'cancelled')
          throw new IngestionCancelledError('Document ingestion was cancelled');
        assertIngestionTransition(lockedVersion.ingestionStatus, 'ready');
        lockedVersion.ingestionStatus = 'ready';
        lockedVersion.readyAt = new Date();
        lockedVersion.errorCode = null;
        lockedVersion.errorMessage = null;
        await manager.getRepository(DocumentVersionEntity).save(lockedVersion);

        lockedJob.status = 'completed';
        lockedJob.progress = 100;
        lockedJob.errorMessage = null;
        lockedJob.completedAt = new Date();
        lockedJob.deadLetteredAt = null;
        await manager.getRepository(IngestionJobEntity).save(lockedJob);
      });
      await job.updateProgress(100);
      return { status: 'ready' };
    } catch (error) {
      if (error instanceof StaleIngestionJobError) return { status: 'stale' };
      if (error instanceof IngestionCancelledError) {
        await this.updateStage(
          data.documentVersionId,
          activeStage,
          'cancelled',
          Number(job.progress) || 0,
          error.message,
        );
        return { status: 'cancelled' };
      }
      const latestJob = await this.jobRepository.findOneBy({ id: data.documentVersionId });
      if (!latestJob || latestJob.generation !== data.generation) return { status: 'stale' };
      if (latestJob.status === 'cancelled' || latestJob.cancellationRequestedAt) {
        await this.updateStage(
          data.documentVersionId,
          activeStage,
          'cancelled',
          Number(job.progress) || 0,
          'Document ingestion was cancelled',
        );
        return { status: 'cancelled' };
      }
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = Number(job.opts.attempts ?? ingestionJob.maxAttempts);
      const finalAttempt = job.attemptsMade + 1 >= maxAttempts;
      const persistedVersion = await this.versionRepository.findOneBy({ id: version.id });
      const nextStatus = finalAttempt ? 'failed' : 'retrying';
      if (
        persistedVersion &&
        canTransitionIngestionStatus(persistedVersion.ingestionStatus, nextStatus)
      ) {
        persistedVersion.ingestionStatus = nextStatus;
        persistedVersion.errorCode = finalAttempt ? 'INGESTION_FAILED' : 'INGESTION_RETRYING';
        persistedVersion.errorMessage = message.slice(0, 4000);
        await this.versionRepository.save(persistedVersion);
      }
      await this.updateStage(
        data.documentVersionId,
        activeStage,
        'failed',
        Number(job.progress) || 0,
        message,
      );
      await this.updateJob(
        data.documentVersionId,
        data.generation,
        finalAttempt ? 'failed' : 'queued',
        Number(job.progress) || 0,
        job.attemptsMade + 1,
        message,
        finalAttempt,
      );
      if (finalAttempt)
        logEvent('ingestion.dead_lettered', {
          jobId: job.id,
          versionId: data.documentVersionId,
          attempts: job.attemptsMade + 1,
          error: message,
        });
      throw error;
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<DocumentIngestionJob>): void {
    logEvent('ingestion.completed', { jobId: job.id, documentId: job.data.documentId });
  }

  private async prepareForAttempt(
    version: DocumentVersionEntity,
    data: DocumentIngestionJob,
  ): Promise<void> {
    if (version.ingestionStatus === 'cancelled')
      throw new IngestionCancelledError('Document ingestion was cancelled');
    if (version.ingestionStatus === 'received') {
      await this.transitionVersion(version, 'stored', data);
      return;
    }
    if (version.ingestionStatus === 'stored') return;

    if (version.ingestionStatus !== 'retrying')
      await this.transitionVersion(version, 'retrying', data);
    await this.transitionVersion(version, 'received', data);
    await this.transitionVersion(version, 'stored', data);
  }

  private async transitionVersion(
    version: DocumentVersionEntity,
    next: IngestionStatus,
    data: DocumentIngestionJob,
  ): Promise<void> {
    await this.assertRunnable(data);
    const persisted = await this.versionRepository.findOneBy({ id: version.id });
    if (!persisted) throw new Error(`Document version ${version.id} not found`);
    if (persisted.ingestionStatus === 'cancelled')
      throw new IngestionCancelledError('Document ingestion was cancelled');
    assertIngestionTransition(persisted.ingestionStatus, next);
    await this.versionRepository.update(version.id, { ingestionStatus: next });
    version.ingestionStatus = next;
  }

  private async persistParsedDocument(
    data: DocumentIngestionJob,
    version: DocumentVersionEntity,
    parsed: ParsedDocument,
  ): Promise<{ markdown: string; checksum: string }> {
    const markdownKey = `tenants/${data.tenantId}/documents/${data.documentId}/versions/${data.documentVersionId}/parsed/document.md`;
    const failedAssetFilenames: string[] = [];
    const uploadedAssets = await Promise.all(
      parsed.assets.map(async (asset, index) => {
        const ordinal = index + 1;
        const safeFilename = safeAssetFilename(asset.filename, ordinal);
        const objectKey = `tenants/${data.tenantId}/documents/${data.documentId}/versions/${data.documentVersionId}/parsed/assets/${String(ordinal).padStart(4, '0')}-${safeFilename}`;
        const sha256 = createHash('sha256').update(asset.bytes).digest('hex');
        try {
          await this.storage.putObject({
            key: objectKey,
            body: asset.bytes,
            contentType: asset.mimeType,
            metadata: {
              sha256,
              parser: `${parsed.parserName}@${parsed.parserVersion}`,
            },
          });
          return {
            id: randomUUID(),
            tenantId: data.tenantId,
            documentVersionId: version.id,
            kind: asset.kind,
            filename: asset.filename,
            objectKey,
            mimeType: asset.mimeType,
            sizeBytes: asset.bytes.byteLength,
            sha256,
            pageNo: asset.anchor?.page ?? null,
            ordinal,
          };
        } catch (error) {
          failedAssetFilenames.push(asset.filename);
          logEvent('ingestion.asset_skipped', {
            versionId: data.documentVersionId,
            filename: asset.filename,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      }),
    );
    const assetRecords = uploadedAssets.filter((asset) => asset !== null);
    await this.assertRunnable(data);
    let normalizedMarkdown = parsed.markdown;
    for (const filename of failedAssetFilenames) {
      normalizedMarkdown = markAssetUnavailable(normalizedMarkdown, filename);
    }
    const markdownBytes = new TextEncoder().encode(normalizedMarkdown);
    const markdownSha256 = createHash('sha256').update(markdownBytes).digest('hex');
    await this.storage.putObject({
      key: markdownKey,
      body: markdownBytes,
      contentType: 'text/markdown; charset=utf-8',
      metadata: {
        sha256: markdownSha256,
        parser: `${parsed.parserName}@${parsed.parserVersion}`,
      },
    });

    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(DocumentSourceAnchorEntity)
        .delete({ documentVersionId: version.id });
      await manager.getRepository(DocumentAssetEntity).delete({ documentVersionId: version.id });
      const anchors = parsed.anchors.map((anchor) =>
        manager.getRepository(DocumentSourceAnchorEntity).create({
          id: randomUUID(),
          tenantId: data.tenantId,
          documentVersionId: version.id,
          anchorType: anchor.type,
          pageNo: anchor.page ?? null,
          slideNo: anchor.slide ?? null,
          sheetName: anchor.sheet ?? null,
          rowStart: anchor.rowStart ?? null,
          rowEnd: anchor.rowEnd ?? null,
          heading: anchor.heading ?? null,
          markdownOffsetStart: anchor.offsetStart,
          markdownOffsetEnd: anchor.offsetEnd,
        }),
      );
      await manager.getRepository(DocumentSourceAnchorEntity).save(anchors);
      if (assetRecords.length > 0) {
        await manager
          .getRepository(DocumentAssetEntity)
          .save(
            assetRecords.map((asset) => manager.getRepository(DocumentAssetEntity).create(asset)),
          );
      }

      const lockedVersion = await manager.getRepository(DocumentVersionEntity).findOne({
        where: { id: version.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!lockedVersion) throw new Error(`Document version ${version.id} not found`);
      if (lockedVersion.ingestionStatus === 'cancelled')
        throw new IngestionCancelledError('Document ingestion was cancelled');
      lockedVersion.markdownBucket = this.storage.bucket;
      lockedVersion.markdownObjectKey = markdownKey;
      lockedVersion.parserName = parsed.parserName;
      lockedVersion.parserVersion = parsed.parserVersion;
      lockedVersion.wordCount = countWords(normalizedMarkdown);
      await manager.getRepository(DocumentVersionEntity).save(lockedVersion);
    });
    return { markdown: normalizedMarkdown, checksum: markdownSha256 };
  }

  private async updateJob(
    jobId: string,
    generation: number,
    status: IngestionJobEntity['status'],
    progress: number,
    attempts: number,
    errorMessage: string | null,
    deadLettered = false,
  ): Promise<void> {
    const ingestionJob = await this.jobRepository.findOne({ where: { id: jobId } });
    if (!ingestionJob) throw new Error(`Ingestion job ${jobId} not found`);
    if (ingestionJob.generation !== generation)
      throw new StaleIngestionJobError('A newer ingestion generation is active');
    if (ingestionJob.status === 'cancelled')
      throw new IngestionCancelledError('Document ingestion was cancelled');
    ingestionJob.status = status;
    ingestionJob.progress = progress;
    ingestionJob.attempts = attempts;
    ingestionJob.errorMessage = errorMessage?.slice(0, 4000) ?? null;
    ingestionJob.deadLetteredAt = deadLettered ? new Date() : null;
    ingestionJob.completedAt = status === 'failed' ? new Date() : null;
    await this.jobRepository.save(ingestionJob);
  }

  private async updateStage(
    jobId: string,
    stage: IngestionStatus,
    status: IngestionStageStatus,
    progress: number,
    errorMessage: string | null = null,
    inputChecksum: string | null = null,
    outputChecksum: string | null = null,
  ): Promise<void> {
    let record = await this.stageRepository.findOne({ where: { jobId, stage } });
    record ??= this.stageRepository.create({
      id: randomUUID(),
      jobId,
      stage,
      startedAt: new Date(),
      processorVersion: PROCESSOR_VERSION,
      inputChecksum: null,
      outputChecksum: null,
      runCount: 0,
    });
    if (status === 'active') record.runCount += 1;
    record.status = status;
    record.progress = progress;
    record.errorMessage = errorMessage?.slice(0, 4000) ?? null;
    record.processorVersion = PROCESSOR_VERSION;
    if (inputChecksum) record.inputChecksum = inputChecksum;
    if (outputChecksum) record.outputChecksum = outputChecksum;
    record.completedAt = status === 'active' ? null : new Date();
    await this.stageRepository.save(record);
  }

  private async assertRunnable(data: DocumentIngestionJob): Promise<void> {
    const job = await this.jobRepository.findOneBy({ id: data.documentVersionId });
    if (!job || job.generation !== data.generation)
      throw new StaleIngestionJobError('A newer ingestion generation is active');
    if (job.status === 'cancelled' || job.cancellationRequestedAt)
      throw new IngestionCancelledError('Document ingestion was cancelled');
  }
}

function countWords(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const other = trimmed
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return cjk + other;
}

function safeAssetFilename(filename: string, ordinal: number): string {
  return (
    basename(filename)
      .replace(/[^\w.\-]+/g, '_')
      .slice(0, 160) || `asset-${ordinal}`
  );
}

function markAssetUnavailable(markdown: string, filename: string): string {
  const reference = `knowledge-asset://${encodeURIComponent(filename)}`;
  const unavailable = `#${'asset-unavailable'.padEnd(reference.length - 1, '-').slice(0, reference.length - 1)}`;
  return markdown.replaceAll(reference, unavailable);
}

function checksumParsedDocument(parsed: ParsedDocument): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        markdown: parsed.markdown,
        anchors: parsed.anchors,
        assets: parsed.assets.map((asset) => ({
          filename: asset.filename,
          mimeType: asset.mimeType,
          sha256: createHash('sha256').update(asset.bytes).digest('hex'),
          anchor: asset.anchor,
        })),
        parserName: parsed.parserName,
        parserVersion: parsed.parserVersion,
      }),
    )
    .digest('hex');
}
