import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { ServerEnv } from '@knowledge-base/config';
import {
  DocumentChunkEntity,
  DocumentEntity,
  DocumentSourceAnchorEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { createEmbeddingGateway, type ModelGateway } from '@knowledge-base/model-gateway';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { logEvent } from '@knowledge-base/observability';
import {
  CHUNKER_VERSION,
  ElasticsearchChunkIndex,
  chunkMarkdown,
  type SourceAnchor,
} from '@knowledge-base/rag';
import { createHash } from 'node:crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { OBJECT_STORAGE } from './worker.constants';
import { ModelQuotaService } from './model-quota.service';

type BuildChunksInput = {
  document: DocumentEntity;
  version: DocumentVersionEntity;
  markdown: string;
  anchors: SourceAnchor[];
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
    @Inject(ModelQuotaService) private readonly modelQuota: ModelQuotaService,
  ) {
    this.embeddingModel = this.config.getOrThrow('EMBEDDING_MODEL');
    this.embedding = createEmbeddingGateway({
      provider: this.config.getOrThrow('MODEL_PROVIDER'),
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      maxConcurrency: this.config.getOrThrow('MODEL_MAX_CONCURRENCY'),
      maxQueueSize: this.config.getOrThrow('MODEL_MAX_QUEUE_SIZE'),
      requestsPerMinute: this.config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
      rateLimiter: this.modelQuota.rateLimiter,
      maxRetries: this.config.getOrThrow('MODEL_MAX_RETRIES'),
      retryBaseDelayMs: this.config.getOrThrow('MODEL_RETRY_BASE_DELAY_MS'),
      circuitFailureThreshold: this.config.getOrThrow('MODEL_CIRCUIT_FAILURE_THRESHOLD'),
      circuitResetMs: this.config.getOrThrow('MODEL_CIRCUIT_RESET_MS'),
      includeUsage: this.config.getOrThrow('MODEL_STREAM_INCLUDE_USAGE'),
      onMetric: (metric) => logEvent('model.call', metric),
    });
    this.keywordIndex = new ElasticsearchChunkIndex(
      this.config.getOrThrow('ELASTICSEARCH_URL'),
      this.config.getOrThrow('ELASTICSEARCH_INDEX'),
    );
  }

  async buildChunks(input: BuildChunksInput): Promise<{ count: number; checksum: string }> {
    const chunks = chunkMarkdown(input.version.id, input.markdown, input.anchors);
    if (chunks.length === 0) throw new Error('Normalized Markdown produced no searchable chunks');
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += 64) {
      vectors.push(
        ...(await this.embedding.embed({
          model: this.embeddingModel,
          inputs: chunks.slice(offset, offset + 64).map((chunk) => chunk.content),
          dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
        })),
      );
    }
    if (vectors.length !== chunks.length)
      throw new Error('Embedding result count does not match chunks');
    const principalIds = input.document.accessPrincipalIds;
    if (principalIds.length === 0) throw new Error('Document has no access principals');
    const records = chunks.map((chunk, index) => {
      const vector = vectors[index];
      if (!vector) throw new Error(`Embedding missing for chunk ${chunk.id}`);
      return this.chunkRepository.create({
        id: chunk.id,
        tenantId: input.document.tenantId,
        documentId: input.document.id,
        documentVersionId: input.version.id,
        ordinal: chunk.ordinal,
        content: chunk.content,
        contentSha256: chunk.contentSha256,
        tokenCount: chunk.tokenCount,
        anchorType: chunk.anchor.type,
        pageNo: chunk.anchor.page ?? null,
        slideNo: chunk.anchor.slide ?? null,
        sheetName: chunk.anchor.sheet ?? null,
        rowStart: chunk.anchor.rowStart ?? null,
        rowEnd: chunk.anchor.rowEnd ?? null,
        heading: chunk.anchor.heading ?? null,
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
      .update(chunks.map((chunk) => `${chunk.id}:${chunk.contentSha256}`).join('\n'))
      .digest('hex');
    return { count: chunks.length, checksum };
  }

  async indexKeywords(document: DocumentEntity, versionId: string): Promise<number> {
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
    await this.keywordIndex.replaceVersion(
      versionId,
      chunks.map((chunk) => ({
        id: chunk.id,
        tenantId: chunk.tenantId,
        principalIds: chunk.principalIds,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
        spaceId: document.spaceId,
        folderId: document.folderId,
        tagIds,
        title: document.title,
        content: chunk.content,
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
      const built = await this.buildChunks({
        document,
        version,
        markdown,
        anchors: anchors.map(sourceAnchorEntity),
      });
      await this.indexKeywords(document, version.id);
      chunkCount += built.count;
    }
    return { versions: versions.length, chunks: chunkCount };
  }
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
    offsetStart: chunk.markdownOffsetStart,
    offsetEnd: chunk.markdownOffsetEnd,
  };
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
