import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  SearchDocumentHit,
  SearchDiagnostics,
  SearchDocumentsRequest,
  SearchDocumentsResponse,
  SearchFacets,
  SearchGovernanceQueryItem,
  SearchGovernanceRecentItem,
  SearchGovernanceResponse,
  SearchQuerySource,
} from '@knowledge-base/contracts';
import { SearchQueryEventEntity } from '@knowledge-base/database';
import {
  countModelTextTokens,
  createEmbeddingGateway,
  createRerankGateway,
  LOCAL_LEXICAL_RERANKER_MODEL,
  LocalLexicalRerankGateway,
  truncateModelTextToTokens,
  type ModelGateway,
  type ModelTokenizerEncoding,
  type RerankGateway,
} from '@knowledge-base/model-gateway';
import {
  ElasticsearchChunkIndex,
  maximalMarginalRelevance,
  parseVectorLiteral,
} from '@knowledge-base/rag';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ModelMetricsService } from '../observability/model-metrics.service';
import { modelRuntimeOptions } from '../observability/model-runtime-options';
import { ModelQuotaService } from '../observability/model-quota.service';
import {
  ModelBudgetExceededError,
  ModelBudgetService,
} from '../observability/model-budget.service';
import { SystemGovernanceService } from '../system-governance/system-governance.service';
import {
  consolidateSearchCandidates,
  type CandidateConsolidationStats,
} from './candidate-consolidation';
import { planRetrievalQuery, type RetrievalQueryPlan } from './query-planning';

type RankedChunk = { id: string; score: number };
type WeightedRanking = { hits: RankedChunk[]; weight: number };

type RerankPreparationStats = {
  inputCandidates: number;
  selectedCandidates: number;
  exactDuplicatesRemoved: number;
  perDocumentLimitRemoved: number;
  candidateLimitRemoved: number;
  tokenBudgetRemoved: number;
  truncatedDocuments: number;
  inputTokens: number;
};

type SearchCommand = SearchDocumentsRequest & {
  tenantId: string;
  userId?: string;
  runId?: string;
  principalIds: string[];
  source?: SearchQuerySource;
  signal?: AbortSignal;
  recordQuery?: boolean;
};

type ChunkRow = {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  ordinal: number;
  contentSha256: string;
  embeddingInputSha256: string;
  title: string;
  content: string;
  contextualContent: string;
  contextSummary: string | null;
  anchorType: SearchDocumentHit['source']['type'];
  pageNo: number | null;
  slideNo: number | null;
  sheetName: string | null;
  rowStart: number | null;
  rowEnd: number | null;
  cellRange: string | null;
  heading: string | null;
  elementType: string | null;
  elementIds: string[];
  sectionPath: string[];
  tableId: string | null;
  figureId: string | null;
  boundingBoxes: Array<{ x: number; y: number; width: number; height: number }>;
  sourceConfidence: number | null;
  offsetStart: number;
  offsetEnd: number;
  spaceId: string | null;
  folderId: string | null;
  tagIds: string[];
  embedding: string | number[];
};

type GovernanceSummaryRow = {
  totalQueries: string;
  directSearchQueries: string;
  answerQueries: string;
  failedQueries: string;
  zeroResultQueries: string;
  averageDurationMs: string | null;
  p95DurationMs: string | null;
  averageResultCount: string | null;
};

@Injectable()
export class SearchService {
  private readonly embedding: Pick<ModelGateway, 'embed'>;
  private readonly reranker: RerankGateway;
  private readonly fallbackReranker: RerankGateway;
  private readonly keywordIndex: ElasticsearchChunkIndex;
  private readonly embeddingModel: string;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
    @Inject(ModelQuotaService) private readonly modelQuota?: ModelQuotaService,
    @Inject(SystemGovernanceService)
    private readonly systemGovernance?: SystemGovernanceService,
    @Optional()
    @Inject(ModelBudgetService)
    private readonly modelBudget?: ModelBudgetService,
  ) {
    this.embeddingModel = this.config.getOrThrow('EMBEDDING_MODEL');
    this.embedding = createEmbeddingGateway({
      provider: this.config.getOrThrow('MODEL_PROVIDER'),
      baseUrl: this.config.get('MODEL_BASE_URL'),
      apiKey: this.config.get('MODEL_API_KEY'),
      dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      ...modelRuntimeOptions(
        this.config,
        this.modelMetrics.observe,
        this.modelQuota?.rateLimiter,
        this.modelQuota?.circuitBreaker,
      ),
    });
    this.reranker = createRerankGateway({
      provider: this.config.getOrThrow('RERANKER_PROVIDER'),
      url: this.config.get('RERANKER_URL'),
      apiKey: this.config.get('RERANKER_API_KEY'),
      timeoutMs: this.config.getOrThrow('MODEL_REQUEST_TIMEOUT_MS'),
      ...modelRuntimeOptions(
        this.config,
        this.modelMetrics.observe,
        this.modelQuota?.rateLimiter,
        this.modelQuota?.circuitBreaker,
      ),
    });
    this.fallbackReranker = new LocalLexicalRerankGateway(
      this.modelMetrics.observe,
      this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
    );
    this.keywordIndex = new ElasticsearchChunkIndex(
      this.config.getOrThrow('ELASTICSEARCH_URL'),
      this.config.getOrThrow('ELASTICSEARCH_INDEX'),
    );
  }

  async search(input: SearchCommand): Promise<SearchDocumentsResponse> {
    const startedAt = Date.now();
    const timingsMs: SearchDiagnostics['timingsMs'] = {
      settings: 0,
      embedding: 0,
      vector: 0,
      keyword: 0,
      fusion: 0,
      hydration: 0,
      rerank: 0,
      consolidation: 0,
      mmr: 0,
      total: 0,
    };
    const settingsStartedAt = Date.now();
    const settings = this.systemGovernance
      ? await this.systemGovernance.effectiveSettings(input.tenantId)
      : {
          candidateLimit: 200,
          scoreThreshold: 0,
          defaultPageSize: 10,
          feedbackEnabled: true,
          auditRetentionDays: 365,
        };
    timingsMs.settings = Date.now() - settingsStartedAt;
    const queryPlan = planRetrievalQuery(input.text, {
      baseCandidateLimit: settings.candidateLimit,
      requestedResultLimit: input.limit,
      source: input.source,
      enabled: this.config.getOrThrow('RAG_QUERY_PLANNING_ENABLED'),
    });
    const candidateLimit = queryPlan.candidateLimit;
    const resultLimit = queryPlan.resultLimit;
    const mmrLambda = this.config.getOrThrow('RAG_MMR_LAMBDA');
    const nearDuplicateThreshold = this.config.getOrThrow('RAG_NEAR_DUPLICATE_THRESHOLD');
    let vectorCandidateCount = 0;
    let keywordCandidateCount = 0;
    try {
      const keywordStartedAt = Date.now();
      const keywordPromise = this.keywordIndex
        .searchMany(
          input.tenantId,
          input.principalIds,
          queryPlan.variants.map((variant) => variant.text),
          candidateLimit,
          {
            spaceId: input.spaceId,
            folderId: input.folderId,
            tagIds: input.tagIds,
          },
        )
        .then((rankings) =>
          weightedReciprocalRankFusion(
            rankings.map((hits, index) => ({
              hits,
              weight: queryPlan.variants[index]?.weight ?? 1,
            })),
          ),
        )
        .finally(() => {
          timingsMs.keyword = Date.now() - keywordStartedAt;
        });
      const vectorVariants = queryPlan.variants.filter((variant) => variant.useVector);
      const embeddingAssessment = await this.modelBudget?.assess({
        tenantId: input.tenantId,
        operation: 'embedding',
        model: this.embeddingModel,
        inputTokens: vectorVariants.reduce(
          (total, variant) =>
            total +
            countModelTextTokens(
              this.embeddingModel,
              variant.text,
              this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
            ),
          0,
        ),
        maxOutputTokens: 0,
      });
      if (embeddingAssessment?.mode === 'reject') {
        throw new ModelBudgetExceededError(embeddingAssessment);
      }
      let vectorHits: RankedChunk[] = [];
      if (embeddingAssessment?.mode !== 'degrade' && vectorVariants.length > 0) {
        const embeddingStartedAt = Date.now();
        const queryVectors = await this.embedding.embed({
          model: this.embeddingModel,
          inputs: vectorVariants.map((variant) => variant.text),
          dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
          signal: input.signal,
          context: modelCallContext(input),
        });
        timingsMs.embedding = Date.now() - embeddingStartedAt;
        if (queryVectors.length !== vectorVariants.length) {
          throw new Error('Embedding model returned an unexpected query vector count');
        }
        const vectorStartedAt = Date.now();
        const vectorRankings = await Promise.all(
          queryVectors.map(async (queryVector, index) => ({
            hits: await this.vectorSearch(input, queryVector, candidateLimit),
            weight: vectorVariants[index]?.weight ?? 1,
          })),
        );
        vectorHits = weightedReciprocalRankFusion(vectorRankings);
        timingsMs.vector = Date.now() - vectorStartedAt;
      }
      const keywordHits = await keywordPromise;
      vectorCandidateCount = vectorHits.length;
      keywordCandidateCount = keywordHits.length;
      const fusionStartedAt = Date.now();
      const fused = weightedReciprocalRankFusion([
        { hits: vectorHits, weight: queryPlan.vectorWeight },
        { hits: keywordHits, weight: queryPlan.keywordWeight },
      ]);
      const fusedCandidates = fused.slice(0, candidateLimit);
      timingsMs.fusion = Date.now() - fusionStartedAt;
      const candidateIds = fusedCandidates.map((hit) => hit.id);
      if (candidateIds.length === 0) {
        const durationMs = Date.now() - startedAt;
        timingsMs.total = durationMs;
        const response = this.emptyResponse(input, durationMs, resultLimit);
        if (input.includeDiagnostics) {
          response.diagnostics = buildDiagnostics(
            candidateLimit,
            queryPlan,
            settings.scoreThreshold,
            mmrLambda,
            nearDuplicateThreshold,
            timingsMs,
            vectorHits,
            keywordHits,
            [],
            [],
            [],
            [],
            emptyConsolidationStats(),
            emptyRerankPreparationStats(),
            new Map(),
          );
        }
        if (input.recordQuery !== false) {
          response.queryEventId = await this.recordQuery(
            input,
            response.total,
            response.durationMs,
            0,
            0,
            'success',
            queryPlan,
          );
        }
        return response;
      }

      const hydrationIds = input.includeDiagnostics
        ? [...new Set([...vectorHits, ...keywordHits].map((hit) => hit.id))]
        : candidateIds;
      const hydrationStartedAt = Date.now();
      const rows = await this.dataSource.query<ChunkRow[]>(
        `
        SELECT chunk.id AS "chunkId",
               chunk.document_id AS "documentId",
               chunk.document_version_id AS "documentVersionId",
               chunk.ordinal,
               chunk.content_sha256 AS "contentSha256",
               chunk.embedding_input_sha256 AS "embeddingInputSha256",
               document.title,
               chunk.content,
               chunk.contextual_content AS "contextualContent",
               chunk.context_summary AS "contextSummary",
               chunk.anchor_type AS "anchorType",
               chunk.page_no AS "pageNo",
               chunk.slide_no AS "slideNo",
               chunk.sheet_name AS "sheetName",
               chunk.row_start AS "rowStart",
               chunk.row_end AS "rowEnd",
               chunk.cell_range AS "cellRange",
               chunk.heading,
               chunk.element_type AS "elementType",
               chunk.element_ids AS "elementIds",
               chunk.section_path AS "sectionPath",
               chunk.table_id AS "tableId",
               chunk.figure_id AS "figureId",
               chunk.bounding_boxes AS "boundingBoxes",
               chunk.source_confidence AS "sourceConfidence",
               chunk.markdown_offset_start AS "offsetStart",
               chunk.markdown_offset_end AS "offsetEnd",
               chunk.embedding::text AS embedding,
               document.space_id AS "spaceId",
               document.folder_id AS "folderId",
               COALESCE((
                 SELECT array_agg(tagged.tag_id ORDER BY tagged.tag_id)
                 FROM document_tag tagged
                 WHERE tagged.tenant_id = document.tenant_id
                   AND tagged.document_id = document.id
               ), ARRAY[]::uuid[]) AS "tagIds"
        FROM document_chunk chunk
        INNER JOIN document ON document.id = chunk.document_id
        WHERE chunk.id = ANY($1::uuid[])
          AND chunk.tenant_id = $2::uuid
          AND chunk.principal_ids && $3::varchar[]
          AND chunk.embedding_model = $7
          AND document.deleted_at IS NULL
          AND document.status = 'published'
          AND document.current_ready_version_id = chunk.document_version_id
          AND ($4::uuid IS NULL OR document.space_id = $4::uuid)
          AND ($5::uuid IS NULL OR document.folder_id = $5::uuid)
          AND (
            COALESCE(cardinality($6::uuid[]), 0) = 0
            OR (
              SELECT COUNT(DISTINCT tagged.tag_id)
              FROM document_tag tagged
              WHERE tagged.tenant_id = document.tenant_id
                AND tagged.document_id = document.id
                AND tagged.tag_id = ANY($6::uuid[])
            ) = cardinality($6::uuid[])
          )
        `,
        [
          hydrationIds,
          input.tenantId,
          input.principalIds,
          input.spaceId ?? null,
          input.folderId ?? null,
          input.tagIds ?? [],
          this.embeddingModel,
        ],
      );
      timingsMs.hydration = Date.now() - hydrationStartedAt;
      const byId = new Map(rows.map((row) => [row.chunkId, row]));
      const hits = hydrateRankedHits(fusedCandidates, byId);
      const rerankerModel = this.config.getOrThrow('RERANKER_MODEL');
      const rerankPreparation = prepareRerankCandidates(
        input.text,
        hits.flatMap((hit) => {
          const row = byId.get(hit.chunkId);
          return row ? [{ hit, contentSha256: row.embeddingInputSha256 ?? row.contentSha256 }] : [];
        }),
        {
          model: rerankerModel,
          tokenizerEncoding: this.config.getOrThrow('MODEL_TOKENIZER_ENCODING'),
          candidateLimit: Math.min(
            candidateLimit,
            this.config.getOrThrow('RAG_RERANK_CANDIDATE_LIMIT'),
          ),
          maxTokens: this.config.getOrThrow('RAG_RERANK_MAX_TOKENS'),
          maxChunksPerDocument: maxChunksPerDocumentForSource(
            input.source,
            this.config.getOrThrow('RAG_MAX_CHUNKS_PER_DOCUMENT'),
            candidateLimit,
          ),
        },
      );
      const rerankStartedAt = Date.now();
      const rerankAssessment = await this.modelBudget?.assess({
        tenantId: input.tenantId,
        operation: 'rerank',
        model: rerankerModel,
        inputTokens: rerankPreparation.stats.inputTokens,
        maxOutputTokens: 0,
      });
      if (rerankAssessment?.mode === 'reject') {
        throw new ModelBudgetExceededError(rerankAssessment);
      }
      const activeReranker =
        rerankAssessment?.mode === 'degrade' ? this.fallbackReranker : this.reranker;
      const activeRerankerModel =
        rerankAssessment?.mode === 'degrade' ? LOCAL_LEXICAL_RERANKER_MODEL : rerankerModel;
      const reranked =
        rerankPreparation.documents.length === 0
          ? []
          : await activeReranker.rerank({
              model: activeRerankerModel,
              query: input.text,
              documents: rerankPreparation.documents,
              topN: rerankPreparation.documents.length,
              signal: input.signal,
              context: modelCallContext(input),
            });
      timingsMs.rerank = Date.now() - rerankStartedAt;
      const hitsById = new Map(rerankPreparation.hits.map((hit) => [hit.chunkId, hit]));
      const rerankedHits = reranked
        .map((result) => {
          const hit = hitsById.get(result.id);
          return hit ? { ...hit, score: result.score } : null;
        })
        .filter((hit): hit is SearchDocumentHit => hit !== null);
      const relevantHits = rerankedHits.filter((hit) => hit.score > settings.scoreThreshold);
      const consolidationStartedAt = Date.now();
      const consolidation = consolidateSearchCandidates(
        relevantHits.flatMap((hit) => {
          const row = byId.get(hit.chunkId);
          return row
            ? [
                {
                  hit,
                  ordinalStart: row.ordinal,
                  ordinalEnd: row.ordinal,
                  contentSha256: row.embeddingInputSha256 ?? row.contentSha256,
                  embedding: parseVectorLiteral(row.embedding),
                },
              ]
            : [];
        }),
        nearDuplicateThreshold,
      );
      consolidation.stats.exactDuplicatesRemoved += rerankPreparation.stats.exactDuplicatesRemoved;
      timingsMs.consolidation = Date.now() - consolidationStartedAt;
      const mmrStartedAt = Date.now();
      const offset = (input.page - 1) * resultLimit;
      const rankedHits = maximalMarginalRelevance(
        consolidation.candidates.map((candidate) => ({
          id: candidate.hit.chunkId,
          relevanceScore: candidate.hit.score,
          embedding: candidate.embedding,
          hit: candidate.hit,
        })),
        { lambda: mmrLambda, limit: offset + resultLimit },
      ).map((candidate) => candidate.hit);
      timingsMs.mmr = Date.now() - mmrStartedAt;
      const durationMs = Date.now() - startedAt;
      timingsMs.total = durationMs;
      const candidateIdSet = new Set(candidateIds);
      const candidateRows = rows.filter((row) => candidateIdSet.has(row.chunkId));
      const response: SearchDocumentsResponse = {
        queryEventId: null,
        query: input.text,
        hits: rankedHits.slice(offset, offset + resultLimit),
        total: consolidation.candidates.length,
        page: input.page,
        pageSize: resultLimit,
        durationMs,
        facets: buildFacets(candidateRows),
      };
      if (input.includeDiagnostics) {
        response.diagnostics = buildDiagnostics(
          candidateLimit,
          queryPlan,
          settings.scoreThreshold,
          mmrLambda,
          nearDuplicateThreshold,
          timingsMs,
          vectorHits,
          keywordHits,
          fusedCandidates,
          reranked,
          consolidation.candidates.map((candidate) => candidate.hit),
          rankedHits,
          consolidation.stats,
          rerankPreparation.stats,
          byId,
        );
      }
      if (input.recordQuery !== false) {
        response.queryEventId = await this.recordQuery(
          input,
          response.total,
          durationMs,
          vectorCandidateCount,
          keywordCandidateCount,
          'success',
          queryPlan,
        );
      }
      return response;
    } catch (error) {
      if (input.recordQuery !== false) {
        await this.recordQuery(
          input,
          0,
          Date.now() - startedAt,
          vectorCandidateCount,
          keywordCandidateCount,
          'failed',
          queryPlan,
          errorCode(error),
        );
      }
      throw error;
    }
  }

  private async vectorSearch(
    input: SearchCommand,
    queryVector: number[],
    candidateLimit: number,
  ): Promise<RankedChunk[]> {
    const vectorLiteral = `[${queryVector.join(',')}]`;
    return this.dataSource.query<RankedChunk[]>(
      `
      SELECT chunk.id,
             1 - (chunk.embedding <=> $1::vector) AS score
      FROM document_chunk chunk
      INNER JOIN document ON document.id = chunk.document_id
      WHERE chunk.tenant_id = $2::uuid
        AND chunk.principal_ids && $3::varchar[]
        AND chunk.embedding_model = $8
        AND document.deleted_at IS NULL
        AND document.status = 'published'
        AND document.current_ready_version_id = chunk.document_version_id
        AND ($5::uuid IS NULL OR document.space_id = $5::uuid)
        AND ($6::uuid IS NULL OR document.folder_id = $6::uuid)
        AND (
          COALESCE(cardinality($7::uuid[]), 0) = 0
          OR (
            SELECT COUNT(DISTINCT tagged.tag_id)
            FROM document_tag tagged
            WHERE tagged.tenant_id = document.tenant_id
              AND tagged.document_id = document.id
              AND tagged.tag_id = ANY($7::uuid[])
          ) = cardinality($7::uuid[])
        )
      ORDER BY chunk.embedding <=> $1::vector
      LIMIT $4
      `,
      [
        vectorLiteral,
        input.tenantId,
        input.principalIds,
        candidateLimit,
        input.spaceId ?? null,
        input.folderId ?? null,
        input.tagIds ?? [],
        this.embeddingModel,
      ],
    );
  }

  async source(input: {
    chunkId: string;
    tenantId: string;
    principalIds: string[];
  }): Promise<SearchDocumentHit> {
    const rows = await this.dataSource.query<ChunkRow[]>(
      `
      SELECT chunk.id AS "chunkId",
             chunk.document_id AS "documentId",
             chunk.document_version_id AS "documentVersionId",
             chunk.ordinal,
             chunk.content_sha256 AS "contentSha256",
             chunk.embedding_input_sha256 AS "embeddingInputSha256",
             document.title,
             chunk.content,
             chunk.contextual_content AS "contextualContent",
             chunk.context_summary AS "contextSummary",
             chunk.anchor_type AS "anchorType",
             chunk.page_no AS "pageNo",
             chunk.slide_no AS "slideNo",
             chunk.sheet_name AS "sheetName",
             chunk.row_start AS "rowStart",
             chunk.row_end AS "rowEnd",
             chunk.cell_range AS "cellRange",
             chunk.heading,
             chunk.element_type AS "elementType",
             chunk.element_ids AS "elementIds",
             chunk.section_path AS "sectionPath",
             chunk.table_id AS "tableId",
             chunk.figure_id AS "figureId",
             chunk.bounding_boxes AS "boundingBoxes",
             chunk.source_confidence AS "sourceConfidence",
             chunk.markdown_offset_start AS "offsetStart",
             chunk.markdown_offset_end AS "offsetEnd",
             chunk.embedding::text AS embedding,
             document.space_id AS "spaceId",
             document.folder_id AS "folderId",
             ARRAY[]::uuid[] AS "tagIds"
      FROM document_chunk chunk
      INNER JOIN document ON document.id = chunk.document_id
      WHERE chunk.id = $1::uuid
        AND chunk.tenant_id = $2::uuid
        AND chunk.principal_ids && $3::varchar[]
        AND document.deleted_at IS NULL
        AND document.status = 'published'
        AND document.current_ready_version_id = chunk.document_version_id
      LIMIT 1
      `,
      [input.chunkId, input.tenantId, input.principalIds],
    );
    const hit = hydrateRankedHits(
      rows.map((row) => ({ id: row.chunkId, score: 1 })),
      new Map(rows.map((row) => [row.chunkId, row])),
    )[0];
    if (!hit) throw new NotFoundException(`Search source ${input.chunkId} not found`);
    return hit;
  }

  async governance(tenantId: string, days: number): Promise<SearchGovernanceResponse> {
    const [summaryRows, topQueries, noResultQueries, recentQueries] = await Promise.all([
      this.dataSource.query<GovernanceSummaryRow[]>(
        `SELECT COUNT(*) AS "totalQueries",
                COUNT(*) FILTER (WHERE source = 'search') AS "directSearchQueries",
                COUNT(*) FILTER (WHERE source = 'answer') AS "answerQueries",
                COUNT(*) FILTER (WHERE status = 'failed') AS "failedQueries",
                COUNT(*) FILTER (WHERE status = 'success' AND result_count = 0) AS "zeroResultQueries",
                AVG(duration_ms) AS "averageDurationMs",
                percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS "p95DurationMs",
                AVG(result_count) FILTER (WHERE status = 'success') AS "averageResultCount"
         FROM search_query_event
         WHERE tenant_id = $1 AND created_at >= now() - make_interval(days => $2)`,
        [tenantId, days],
      ),
      this.groupedQueries(tenantId, days, false),
      this.groupedQueries(tenantId, days, true),
      this.dataSource.query<
        Array<{
          id: string;
          query: string;
          source: SearchQuerySource;
          resultCount: number;
          durationMs: number;
          status: 'success' | 'failed';
          createdAt: Date;
        }>
      >(
        `SELECT id, query_text AS query, source,
                result_count AS "resultCount", duration_ms AS "durationMs",
                status, created_at AS "createdAt"
         FROM search_query_event
         WHERE tenant_id = $1 AND created_at >= now() - make_interval(days => $2)
         ORDER BY created_at DESC
         LIMIT 30`,
        [tenantId, days],
      ),
    ]);
    const summary = summaryRows[0];
    const totalQueries = Number(summary?.totalQueries ?? 0);
    const zeroResultQueries = Number(summary?.zeroResultQueries ?? 0);
    return {
      windowDays: days,
      totalQueries,
      directSearchQueries: Number(summary?.directSearchQueries ?? 0),
      answerQueries: Number(summary?.answerQueries ?? 0),
      failedQueries: Number(summary?.failedQueries ?? 0),
      zeroResultQueries,
      zeroResultRate: totalQueries === 0 ? 0 : round(zeroResultQueries / totalQueries, 4),
      averageDurationMs: round(Number(summary?.averageDurationMs ?? 0), 2),
      p95DurationMs: round(Number(summary?.p95DurationMs ?? 0), 2),
      averageResultCount: round(Number(summary?.averageResultCount ?? 0), 2),
      topQueries,
      noResultQueries,
      recentQueries: recentQueries.map((item): SearchGovernanceRecentItem => ({
        ...item,
        resultCount: Number(item.resultCount),
        durationMs: Number(item.durationMs),
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }

  private emptyResponse(
    input: SearchCommand,
    durationMs: number,
    resultLimit: number,
  ): SearchDocumentsResponse {
    return {
      queryEventId: null,
      query: input.text,
      hits: [],
      total: 0,
      page: input.page,
      pageSize: resultLimit,
      durationMs,
      facets: { spaces: [], folders: [], tags: [] },
    };
  }

  private async recordQuery(
    input: SearchCommand,
    resultCount: number,
    durationMs: number,
    vectorCandidateCount: number,
    keywordCandidateCount: number,
    status: 'success' | 'failed',
    queryPlan: RetrievalQueryPlan,
    failureCode: string | null = null,
  ): Promise<string | null> {
    const id = randomUUID();
    try {
      await this.dataSource.getRepository(SearchQueryEventEntity).save({
        id,
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        source: input.source ?? 'search',
        queryText: input.text,
        filters: {
          spaceId: input.spaceId ?? null,
          folderId: input.folderId ?? null,
          tagIds: input.tagIds ?? [],
          page: input.page,
          pageSize: queryPlan.resultLimit,
          queryPlan: {
            version: queryPlan.version,
            enabled: queryPlan.enabled,
            intent: queryPlan.intent,
            variants: queryPlan.variants,
            baseCandidateLimit: queryPlan.baseCandidateLimit,
            candidateLimit: queryPlan.candidateLimit,
            requestedResultLimit: queryPlan.requestedResultLimit,
            resultLimit: queryPlan.resultLimit,
            keywordWeight: queryPlan.keywordWeight,
            vectorWeight: queryPlan.vectorWeight,
          },
        },
        resultCount,
        durationMs,
        vectorCandidateCount,
        keywordCandidateCount,
        status,
        errorCode: failureCode,
      });
      return id;
    } catch (error) {
      logEvent('search.governance_record_failed', {
        tenantId: input.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async groupedQueries(
    tenantId: string,
    days: number,
    onlyZeroResults: boolean,
  ): Promise<SearchGovernanceQueryItem[]> {
    const rows = await this.dataSource.query<
      Array<{
        query: string;
        count: number;
        zeroResultCount: number;
        averageDurationMs: number;
      }>
    >(
      `SELECT MIN(query_text) AS query,
              COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE result_count = 0)::int AS "zeroResultCount",
              ROUND(AVG(duration_ms)::numeric, 2)::float AS "averageDurationMs"
       FROM search_query_event
       WHERE tenant_id = $1
         AND created_at >= now() - make_interval(days => $2)
         AND status = 'success'
         ${onlyZeroResults ? 'AND result_count = 0' : ''}
       GROUP BY lower(query_text)
       ORDER BY count DESC, MAX(created_at) DESC
       LIMIT 10`,
      [tenantId, days],
    );
    return rows.map((row) => ({
      query: row.query,
      count: Number(row.count),
      zeroResultCount: Number(row.zeroResultCount),
      averageDurationMs: Number(row.averageDurationMs),
    }));
  }
}

export function maxChunksPerDocumentForSource(
  source: SearchQuerySource | undefined,
  answerLimit: number,
  candidateLimit: number,
): number {
  return source === 'answer' ? answerLimit : candidateLimit;
}

function buildFacets(rows: ChunkRow[]): SearchFacets {
  const documents = new Map<
    string,
    { spaceId: string | null; folderId: string | null; tagIds: string[] }
  >();
  for (const row of rows) {
    if (!documents.has(row.documentId)) {
      documents.set(row.documentId, {
        spaceId: row.spaceId,
        folderId: row.folderId,
        tagIds: row.tagIds,
      });
    }
  }
  return {
    spaces: countFacets([...documents.values()].flatMap((item) => item.spaceId ?? [])),
    folders: countFacets([...documents.values()].flatMap((item) => item.folderId ?? [])),
    tags: countFacets([...documents.values()].flatMap((item) => item.tagIds)),
  };
}

function countFacets(ids: string[]): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
}

function hydrateRankedHits(
  ranking: RankedChunk[],
  byId: Map<string, ChunkRow>,
): SearchDocumentHit[] {
  const hits: SearchDocumentHit[] = [];
  for (const ranked of ranking) {
    const row = byId.get(ranked.id);
    if (!row) continue;
    hits.push({
      chunkId: row.chunkId,
      documentId: row.documentId,
      documentVersionId: row.documentVersionId,
      title: row.title,
      content: row.content,
      context: row.contextSummary,
      score: ranked.score,
      source: {
        type: row.anchorType,
        page: row.pageNo,
        slide: row.slideNo,
        sheet: row.sheetName,
        rowStart: row.rowStart,
        rowEnd: row.rowEnd,
        range: row.cellRange,
        heading: row.heading,
        offsetStart: row.offsetStart,
        offsetEnd: row.offsetEnd,
        elementType: row.elementType as SearchDocumentHit['source']['elementType'],
        elementIds: row.elementIds,
        sectionPath: row.sectionPath,
        tableId: row.tableId,
        figureId: row.figureId,
        boundingBoxes: row.boundingBoxes,
        confidence: row.sourceConfidence,
      },
    });
  }
  return hits;
}

function buildDiagnostics(
  candidateLimit: number,
  queryPlan: RetrievalQueryPlan,
  scoreThreshold: number,
  mmrLambda: number,
  nearDuplicateThreshold: number,
  timingsMs: SearchDiagnostics['timingsMs'],
  vectorHits: RankedChunk[],
  keywordHits: RankedChunk[],
  fusedHits: RankedChunk[],
  rerankedHits: RankedChunk[],
  consolidatedHits: SearchDocumentHit[],
  selectedHits: SearchDocumentHit[],
  consolidation: CandidateConsolidationStats,
  rerankPreparation: RerankPreparationStats,
  byId: Map<string, ChunkRow>,
): SearchDiagnostics {
  const stage = (ranking: RankedChunk[]) => ({
    candidateCount: ranking.length,
    hits: hydrateRankedHits(ranking, byId),
  });
  return {
    candidateLimit,
    queryPlan,
    scoreThreshold,
    mmrLambda,
    nearDuplicateThreshold,
    consolidation,
    rerankPreparation,
    timingsMs: { ...timingsMs },
    stages: {
      vector: stage(vectorHits),
      keyword: stage(keywordHits),
      rrf: stage(fusedHits),
      reranked: stage(rerankedHits),
      consolidated: {
        candidateCount: consolidatedHits.length,
        hits: consolidatedHits,
      },
      selected: {
        candidateCount: selectedHits.length,
        hits: selectedHits,
      },
    },
  };
}

function emptyConsolidationStats(): CandidateConsolidationStats {
  return {
    exactDuplicatesRemoved: 0,
    adjacentChunksMerged: 0,
    nonAdjacentDuplicatesRemoved: 0,
    crossSourceSimilarPreserved: 0,
  };
}

function emptyRerankPreparationStats(): RerankPreparationStats {
  return {
    inputCandidates: 0,
    selectedCandidates: 0,
    exactDuplicatesRemoved: 0,
    perDocumentLimitRemoved: 0,
    candidateLimitRemoved: 0,
    tokenBudgetRemoved: 0,
    truncatedDocuments: 0,
    inputTokens: 0,
  };
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code).slice(0, 128);
  }
  return error instanceof Error ? error.constructor.name.slice(0, 128) : 'UNKNOWN';
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function modelCallContext(input: SearchCommand) {
  return {
    tenantId: input.tenantId,
    userId: input.userId,
    runId: input.runId,
    source: input.source === 'answer' ? ('answer' as const) : ('search' as const),
  };
}

export function prepareRerankCandidates(
  query: string,
  candidates: Array<{ hit: SearchDocumentHit; contentSha256: string }>,
  options: {
    model: string;
    tokenizerEncoding: ModelTokenizerEncoding;
    candidateLimit: number;
    maxTokens: number;
    maxChunksPerDocument: number;
  },
): {
  hits: SearchDocumentHit[];
  documents: Array<{ id: string; text: string }>;
  stats: RerankPreparationStats;
} {
  const stats = { ...emptyRerankPreparationStats(), inputCandidates: candidates.length };
  const selectedHits: SearchDocumentHit[] = [];
  const documents: Array<{ id: string; text: string }> = [];
  const seenHashes = new Set<string>();
  const documentCounts = new Map<string, number>();
  let inputTokens = countModelTextTokens(options.model, query, options.tokenizerEncoding);

  for (const candidate of candidates) {
    const hash = candidate.contentSha256.trim();
    if (hash && seenHashes.has(hash)) {
      stats.exactDuplicatesRemoved += 1;
      continue;
    }
    const documentCount = documentCounts.get(candidate.hit.documentId) ?? 0;
    if (documentCount >= options.maxChunksPerDocument) {
      stats.perDocumentLimitRemoved += 1;
      continue;
    }
    if (documents.length >= options.candidateLimit) {
      stats.candidateLimitRemoved += 1;
      continue;
    }

    const fullText = [candidate.hit.title, candidate.hit.context, candidate.hit.content]
      .filter(Boolean)
      .join('\n');
    const fullTokens = countModelTextTokens(options.model, fullText, options.tokenizerEncoding);
    const remainingTokens = options.maxTokens - inputTokens - 4;
    if (remainingTokens <= 0) {
      stats.tokenBudgetRemoved += 1;
      continue;
    }
    const text =
      fullTokens <= remainingTokens
        ? fullText
        : truncateModelTextToTokens(
            options.model,
            fullText,
            remainingTokens,
            options.tokenizerEncoding,
          );
    if (!text) {
      stats.tokenBudgetRemoved += 1;
      continue;
    }
    if (text !== fullText) stats.truncatedDocuments += 1;
    inputTokens += countModelTextTokens(options.model, text, options.tokenizerEncoding) + 4;
    if (hash) seenHashes.add(hash);
    documentCounts.set(candidate.hit.documentId, documentCount + 1);
    selectedHits.push(candidate.hit);
    documents.push({ id: candidate.hit.chunkId, text });
  }

  stats.selectedCandidates = documents.length;
  stats.inputTokens = inputTokens;
  return { hits: selectedHits, documents, stats };
}

export function reciprocalRankFusion(rankings: RankedChunk[][], rankConstant = 60): RankedChunk[] {
  return weightedReciprocalRankFusion(
    rankings.map((hits) => ({ hits, weight: 1 })),
    rankConstant,
  );
}

export function weightedReciprocalRankFusion(
  rankings: WeightedRanking[],
  rankConstant = 60,
): RankedChunk[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    if (ranking.weight <= 0) continue;
    ranking.hits.forEach((hit, index) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + ranking.weight / (rankConstant + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
