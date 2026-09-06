import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { ServerEnv } from '@knowledge-base/config';
import {
  DocumentChunkEntity,
  DocumentEntity,
  DocumentSourceAnchorEntity,
  DocumentVersionEntity,
  EmbeddingCacheEntity,
} from '@knowledge-base/database';
import {
  countModelTextTokens,
  createEmbeddingGateway,
  type ModelGateway,
} from '@knowledge-base/model-gateway';
import { ObjectStorage } from '@knowledge-base/object-storage';
import {
  CHUNKER_VERSION,
  ElasticsearchChunkIndex,
  chunkMarkdown,
  type SourceAnchor,
  type StructuredDocument,
} from '@knowledge-base/rag';
import { createHash } from 'node:crypto';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { OBJECT_STORAGE } from './worker.constants';
import { ModelQuotaService } from './model-quota.service';
import { ModelMetricsService } from './model-metrics.service';
import { ModelBudgetService } from './model-budget.service';

type BuildChunksInput = {
  document: DocumentEntity;
  version: DocumentVersionEntity;
  markdown: string;
  anchors: SourceAnchor[];
  structure?: StructuredDocument;
};

type EmbeddingBatchItem = {
  content: string;
  contentSha256: string;
  tokenCount: number;
};

@Injectable()
export class SearchProjectionService {
  private readonly embedding: Pick<ModelGateway, 'embed'>;
  private readonly keywordIndex: ElasticsearchChunkIndex;
  private readonly embeddingModel: string;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(DocumentVersionEntity)
    private readonly versionRepository: Repository<DocumentVersionEntity>,
    @InjectRepository(DocumentSourceAnchorEntity)
    private readonly anchorRepository: Repository<DocumentSourceAnchorEntity>,
    @InjectRepository(DocumentChunkEntity)
    private readonly chunkRepository: Repository<DocumentChunkEntity>,
    @InjectRepository(EmbeddingCacheEntity)
    private readonly embeddingCacheRepository: Repository<EmbeddingCacheEntity>,
    @Inject(ModelQuotaService) private readonly modelQuota: ModelQuotaService,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
    @Inject(ModelBudgetService) private readonly modelBudget: ModelBudgetService,
  ) {
    this.embeddingModel = this.config.getOrThrow('EMBEDDING_MODEL');
    this.embedding = createEmbeddingGateway({
      provider: this.config.getOrThrow('MODEL_PROVIDER'),
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      maxConcurrency: this.config.getOrThrow('MODEL_BATCH_MAX_CONCURRENCY'),
      maxQueueSize: this.config.getOrThrow('MODEL_BATCH_MAX_QUEUE_SIZE'),
      requestsPerMinute: this.config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
      tokenRateLimits: {
        global: this.config.getOrThrow('MODEL_GLOBAL_TOKENS_PER_MINUTE'),
        tenant: this.config.getOrThrow('MODEL_TENANT_TOKENS_PER_MINUTE'),
        user: this.config.getOrThrow('MODEL_USER_TOKENS_PER_MINUTE'),
        model: {
          embedding: this.config.getOrThrow('MODEL_EMBEDDING_TOKENS_PER_MINUTE'),
          chat: this.config.getOrThrow('MODEL_CHAT_TOKENS_PER_MINUTE'),
          rerank: this.config.getOrThrow('MODEL_RERANK_TOKENS_PER_MINUTE'),
        },
      },
      tokenizerEncoding: this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
      rateLimiter: this.modelQuota.rateLimiter,
      circuitBreaker: this.modelQuota.circuitBreaker,
      maxRetries: this.config.getOrThrow('MODEL_MAX_RETRIES'),
      retryBaseDelayMs: this.config.getOrThrow('MODEL_RETRY_BASE_DELAY_MS'),
      circuitFailureThreshold: this.config.getOrThrow('MODEL_CIRCUIT_FAILURE_THRESHOLD'),
      circuitResetMs: this.config.getOrThrow('MODEL_CIRCUIT_RESET_MS'),
      circuitHalfOpenMaxRequests: this.config.getOrThrow('MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS'),
      circuitHalfOpenSuccessThreshold: this.config.getOrThrow(
        'MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD',
      ),
      circuitHalfOpenProbeTimeoutMs: this.config.getOrThrow(
        'MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS',
      ),
      includeUsage: this.config.getOrThrow('MODEL_STREAM_INCLUDE_USAGE'),
      onMetric: this.modelMetrics.observe,
    });
    this.keywordIndex = new ElasticsearchChunkIndex(
      this.config.getOrThrow('ELASTICSEARCH_URL'),
      this.config.getOrThrow('ELASTICSEARCH_INDEX'),
    );
  }

  async buildChunks(input: BuildChunksInput): Promise<{ count: number; checksum: string }> {
    const dimensions = this.config.getOrThrow('EMBEDDING_DIMENSIONS');
    const tokenizerEncoding = this.config.getOrThrow('MODEL_TOKENIZER_ENCODING');
    const rawChunks = chunkMarkdown(input.version.id, input.markdown, input.anchors, {
      structure: input.structure,
    });
    const chunks = rawChunks.map((chunk) => {
      const contextSummary = buildChunkContext(input.document.title, chunk.anchor);
      const contextualContent = this.config.getOrThrow('RAG_CONTEXTUAL_RETRIEVAL_ENABLED')
        ? `${contextSummary}\n\n${chunk.content}`
        : chunk.content;
      return {
        ...chunk,
        contextSummary,
        contextualContent,
        embeddingInputSha256: createHash('sha256').update(contextualContent).digest('hex'),
        embeddingTokenCount: countModelTextTokens(
          this.embeddingModel,
          contextualContent,
          tokenizerEncoding,
        ),
        tokenCount: countModelTextTokens(this.embeddingModel, chunk.content, tokenizerEncoding),
      };
    });
    if (chunks.length === 0) throw new Error('Normalized Markdown produced no searchable chunks');
    if (chunks.length > this.config.getOrThrow('DOCUMENT_MAX_CHUNKS')) {
      throw new Error(
        `Document produced ${chunks.length} chunks, exceeding the configured maximum`,
      );
    }

    const uniqueEmbeddingInputs = [
      ...new Map(
        chunks.map(
          (chunk) =>
            [
              chunk.embeddingInputSha256,
              {
                content: chunk.contextualContent,
                contentSha256: chunk.embeddingInputSha256,
                tokenCount: chunk.embeddingTokenCount,
              },
            ] as const,
        ),
      ).values(),
    ];
    const cached = await this.embeddingCacheRepository.find({
      where: {
        tenantId: input.document.tenantId,
        embeddingModel: this.embeddingModel,
        dimensions,
        contentSha256: In(uniqueEmbeddingInputs.map((chunk) => chunk.contentSha256)),
      },
    });
    const vectorsByHash = new Map(
      cached
        .filter((entry) => entry.embedding.length === dimensions)
        .map((entry) => [entry.contentSha256.trim(), entry.embedding] as const),
    );
    const missingChunks = uniqueEmbeddingInputs.filter(
      (chunk) => !vectorsByHash.has(chunk.contentSha256),
    );
    const batches = buildEmbeddingBatches(
      missingChunks,
      this.config.getOrThrow('EMBEDDING_BATCH_MAX_INPUTS'),
      this.config.getOrThrow('EMBEDDING_BATCH_MAX_TOKENS'),
    );
    for (const batch of batches) {
      await this.modelBudget.assertEmbeddingAllowed(
        input.document.tenantId,
        this.embeddingModel,
        batch.reduce((sum, chunk) => sum + chunk.tokenCount, 0),
      );
      const vectors = await this.embedding.embed({
        model: this.embeddingModel,
        inputs: batch.map((chunk) => chunk.content),
        dimensions,
        context: {
          tenantId: input.document.tenantId,
          runId: input.version.id,
          source: 'ingestion',
        },
      });
      if (vectors.length !== batch.length)
        throw new Error('Embedding result count does not match batch');
      const cacheRecords = batch.map((chunk, index) => {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding missing for content ${chunk.contentSha256}`);
        vectorsByHash.set(chunk.contentSha256, vector);
        return this.embeddingCacheRepository.create({
          tenantId: input.document.tenantId,
          contentSha256: chunk.contentSha256,
          embeddingModel: this.embeddingModel,
          dimensions,
          embedding: vector,
          tokenCount: chunk.tokenCount,
        });
      });
      await this.embeddingCacheRepository.upsert(cacheRecords, [
        'tenantId',
        'contentSha256',
        'embeddingModel',
        'dimensions',
      ]);
    }

    const principalIds = input.document.accessPrincipalIds;
    if (principalIds.length === 0) throw new Error('Document has no access principals');
    const records = chunks.map((chunk) => {
      const vector = vectorsByHash.get(chunk.embeddingInputSha256);
      if (!vector) throw new Error(`Embedding missing for chunk ${chunk.id}`);
      return this.chunkRepository.create({
        id: chunk.id,
        tenantId: input.document.tenantId,
        documentId: input.document.id,
        documentVersionId: input.version.id,
        ordinal: chunk.ordinal,
        content: chunk.content,
        contextualContent: chunk.contextualContent,
        contentSha256: chunk.contentSha256,
        embeddingInputSha256: chunk.embeddingInputSha256,
        tokenCount: chunk.tokenCount,
        anchorType: chunk.anchor.type,
        pageNo: chunk.anchor.page ?? null,
        slideNo: chunk.anchor.slide ?? null,
        sheetName: chunk.anchor.sheet ?? null,
        rowStart: chunk.anchor.rowStart ?? null,
        rowEnd: chunk.anchor.rowEnd ?? null,
        heading: chunk.anchor.heading ?? null,
        elementType: chunk.anchor.elementType ?? null,
        elementIds:
          chunk.anchor.elementIds ?? (chunk.anchor.elementId ? [chunk.anchor.elementId] : []),
        sectionPath: chunk.anchor.sectionPath ?? [],
        tableId: chunk.anchor.tableId ?? null,
        figureId: chunk.anchor.figureId ?? null,
        boundingBoxes: chunk.anchor.boundingBoxes ?? [],
        sourceConfidence: chunk.anchor.confidence ?? null,
        contextSummary: chunk.contextSummary ?? '',
        markdownOffsetStart: chunk.offsetStart,
        markdownOffsetEnd: chunk.offsetEnd,
        principalIds,
        embedding: vector,
        embeddingModel: this.embeddingModel,
        chunkerVersion: CHUNKER_VERSION,
      });
    });
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(DocumentChunkEntity).delete({
        documentVersionId: input.version.id,
      });
      await manager.getRepository(DocumentChunkEntity).save(records, { chunk: 100 });
    });
    const checksum = createHash('sha256')
      .update(
        [
          this.embeddingModel,
          String(dimensions),
          CHUNKER_VERSION,
          ...chunks.map(
            (chunk) => `${chunk.id}:${chunk.contentSha256}:${chunk.embeddingInputSha256}`,
          ),
        ].join('\n'),
      )
      .digest('hex');
    return { count: chunks.length, checksum };
  }

  async indexKeywords(document: DocumentEntity, versionId: string): Promise<number> {
    if (!isPublishedSearchVersion(document, versionId)) {
      await this.keywordIndex.deleteDocument(document.tenantId, document.id);
      return 0;
    }
    const [chunks, tagRows] = await Promise.all([
      this.chunkRepository.find({
        where: { documentVersionId: versionId, tenantId: document.tenantId },
        order: { ordinal: 'ASC' },
      }),
      this.dataSource.query<Array<{ tagId: string }>>(
        `SELECT tag_id AS "tagId"
         FROM document_tag
         WHERE tenant_id = $1 AND document_id = $2
         ORDER BY tag_id`,
        [document.tenantId, document.id],
      ),
    ]);
    const tagIds = tagRows.map((row) => row.tagId);
    await this.keywordIndex.replaceDocument(
      document.tenantId,
      document.id,
      chunks.map((chunk) => ({
        id: chunk.id,
        tenantId: chunk.tenantId,
        principalIds: chunk.principalIds,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
        documentStatus: 'published',
        spaceId: document.spaceId,
        folderId: document.folderId,
        tagIds,
        title: document.title,
        content: chunk.content,
        contextSummary: chunk.contextSummary ?? '',
        anchor: entityAnchor(chunk),
      })),
    );
    return chunks.length;
  }

  async deleteKeywordDocument(tenantId: string, documentId: string): Promise<void> {
    await this.keywordIndex.deleteDocument(tenantId, documentId);
  }

  async rebuildAll(tenantId?: string): Promise<{ versions: number; chunks: number }> {
    await this.keywordIndex.clear(tenantId);
    const query = this.versionRepository
      .createQueryBuilder('version')
      .innerJoin(DocumentEntity, 'document', 'document.id = version.documentId')
      .where('version.ingestionStatus = :status', { status: 'ready' })
      .andWhere('version.markdownObjectKey IS NOT NULL')
      .andWhere('document.deletedAt IS NULL');
    query
      .andWhere('document.status = :documentStatus', { documentStatus: 'published' })
      .andWhere('document.currentReadyVersionId = version.id');
    if (tenantId) query.andWhere('version.tenantId = :tenantId', { tenantId });
    const versions = await query.orderBy('version.createdAt', 'ASC').getMany();
    let chunkCount = 0;
    for (const version of versions) {
      const document = await this.documentRepository.findOne({
        where: { id: version.documentId, tenantId: version.tenantId, deletedAt: IsNull() },
      });
      if (!document || !version.markdownObjectKey) continue;
      const markdown = new TextDecoder().decode(
        await this.storage.getObjectBytes(
          version.markdownObjectKey,
          this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES'),
        ),
      );
      const anchors = await this.anchorRepository.find({
        where: { documentVersionId: version.id, tenantId: version.tenantId },
        order: { markdownOffsetStart: 'ASC' },
      });
      const structure = version.structureObjectKey
        ? parseStructuredDocument(
            new TextDecoder().decode(
              await this.storage.getObjectBytes(
                version.structureObjectKey,
                this.config.getOrThrow('MAX_UPLOAD_SIZE_BYTES'),
              ),
            ),
          )
        : undefined;
      const built = await this.buildChunks({
        document,
        version,
        markdown,
        anchors: anchors.map(sourceAnchorEntity),
        structure,
      });
      await this.indexKeywords(document, version.id);
      chunkCount += built.count;
    }
    return { versions: versions.length, chunks: chunkCount };
  }
}

export function buildEmbeddingBatches<T extends EmbeddingBatchItem>(
  items: readonly T[],
  maxInputs: number,
  maxTokens: number,
): T[][] {
  const boundedMaxInputs = Math.max(1, Math.floor(maxInputs));
  const boundedMaxTokens = Math.max(1, Math.floor(maxTokens));
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchTokens = 0;
  for (const item of items) {
    if (item.tokenCount > boundedMaxTokens) {
      throw new Error(
        `Embedding input requires ${item.tokenCount} tokens, exceeding the batch limit`,
      );
    }
    if (
      batch.length > 0 &&
      (batch.length >= boundedMaxInputs || batchTokens + item.tokenCount > boundedMaxTokens)
    ) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(item);
    batchTokens += item.tokenCount;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function isPublishedSearchVersion(
  document: Pick<DocumentEntity, 'status' | 'currentReadyVersionId'>,
  versionId: string,
): boolean {
  return document.status === 'published' && document.currentReadyVersionId === versionId;
}

function entityAnchor(chunk: DocumentChunkEntity): SourceAnchor {
  return {
    type: chunk.anchorType as SourceAnchor['type'],
    page: chunk.pageNo ?? undefined,
    slide: chunk.slideNo ?? undefined,
    sheet: chunk.sheetName ?? undefined,
    rowStart: chunk.rowStart ?? undefined,
    rowEnd: chunk.rowEnd ?? undefined,
    heading: chunk.heading ?? undefined,
    elementId: chunk.elementIds[0],
    elementIds: chunk.elementIds,
    elementType: chunk.elementType as SourceAnchor['elementType'],
    sectionPath: chunk.sectionPath,
    tableId: chunk.tableId ?? undefined,
    figureId: chunk.figureId ?? undefined,
    boundingBoxes: chunk.boundingBoxes,
    confidence: chunk.sourceConfidence ?? undefined,
    offsetStart: chunk.markdownOffsetStart,
    offsetEnd: chunk.markdownOffsetEnd,
  };
}

function buildChunkContext(title: string, anchor: SourceAnchor): string {
  const fields = [`document_title: ${title}`];
  if (anchor.page) fields.push(`page: ${anchor.page}`);
  if (anchor.slide) fields.push(`slide: ${anchor.slide}`);
  if (anchor.sheet) fields.push(`sheet: ${anchor.sheet}`);
  if (anchor.sectionPath?.length) fields.push(`section: ${anchor.sectionPath.join(' > ')}`);
  else if (anchor.heading) fields.push(`section: ${anchor.heading}`);
  if (anchor.elementType) fields.push(`element_type: ${anchor.elementType}`);
  if (anchor.tableId) fields.push(`table_id: ${anchor.tableId}`);
  if (anchor.figureId) fields.push(`figure_id: ${anchor.figureId}`);
  return fields.join('\n');
}

function sourceAnchorEntity(anchor: DocumentSourceAnchorEntity): SourceAnchor {
  return {
    type: anchor.anchorType as SourceAnchor['type'],
    page: anchor.pageNo ?? undefined,
    slide: anchor.slideNo ?? undefined,
    sheet: anchor.sheetName ?? undefined,
    rowStart: anchor.rowStart ?? undefined,
    rowEnd: anchor.rowEnd ?? undefined,
    heading: anchor.heading ?? undefined,
    offsetStart: anchor.markdownOffsetStart,
    offsetEnd: anchor.markdownOffsetEnd,
  };
}

function parseStructuredDocument(value: string): StructuredDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const structure = parsed as Partial<StructuredDocument>;
    if (structure.version !== 1 || structure.format !== 'pdf' || !Array.isArray(structure.pages)) {
      return undefined;
    }
    return structure as StructuredDocument;
  } catch {
    return undefined;
  }
}
