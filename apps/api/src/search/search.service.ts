import { Inject, Injectable } from '@nestjs/common';
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
  createEmbeddingGateway,
  createRerankGateway,
  type ModelGateway,
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
import { SystemGovernanceService } from '../system-governance/system-governance.service';
import {
  consolidateSearchCandidates,
  type CandidateConsolidationStats,
} from './candidate-consolidation';

type RankedChunk = { id: string; score: number };

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
  title: string;
  content: string;
  anchorType: SearchDocumentHit['source']['type'];
  pageNo: number | null;
  slideNo: number | null;
  sheetName: string | null;
  rowStart: number | null;
  rowEnd: number | null;
  heading: string | null;
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
  private readonly keywordIndex: ElasticsearchChunkIndex;
  private readonly embeddingModel: string;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(ModelMetricsService) private readonly modelMetrics: ModelMetricsService,
    @Inject(ModelQuotaService) private readonly modelQuota?: ModelQuotaService,
    @Inject(SystemGovernanceService)
    private readonly systemGovernance?: SystemGovernanceService,
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
    const candidateLimit = settings.candidateLimit;
    const mmrLambda = this.config.getOrThrow('RAG_MMR_LAMBDA');
    const nearDuplicateThreshold = this.config.getOrThrow('RAG_NEAR_DUPLICATE_THRESHOLD');
    let vectorCandidateCount = 0;
    let keywordCandidateCount = 0;
    try {
      const embeddingStartedAt = Date.now();
      const [queryVector] = await this.embedding.embed({
        model: this.embeddingModel,
        inputs: [input.text],
        dimensions: this.config.getOrThrow('EMBEDDING_DIMENSIONS'),
        signal: input.signal,
        context: modelCallContext(input),
      });
      timingsMs.embedding = Date.now() - embeddingStartedAt;
      if (!queryVector) throw new Error('Embedding model returned no query vector');
      const vectorLiteral = `[${queryVector.join(',')}]`;
      const vectorStartedAt = Date.now();
      const keywordStartedAt = Date.now();
      const vectorPromise = this.dataSource
        .query<RankedChunk[]>(
          `
          SELECT chunk.id,
                 1 - (chunk.embedding <=> $1::vector) AS score
          FROM document_chunk chunk
          INNER JOIN document ON document.id = chunk.document_id
          WHERE chunk.tenant_id = $2::uuid
            AND chunk.principal_ids && $3::varchar[]
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
          ],
        )
        .finally(() => {
          timingsMs.vector = Date.now() - vectorStartedAt;
        });
      const keywordPromise = this.keywordIndex
        .search(input.tenantId, input.principalIds, input.text, candidateLimit, {
          spaceId: input.spaceId,
          folderId: input.folderId,
          tagIds: input.tagIds,
        })
        .finally(() => {
          timingsMs.keyword = Date.now() - keywordStartedAt;
        });
      const [vectorHits, keywordHits] = await Promise.all([vectorPromise, keywordPromise]);
      vectorCandidateCount = vectorHits.length;
      keywordCandidateCount = keywordHits.length;
      const fusionStartedAt = Date.now();
      const fused = reciprocalRankFusion([vectorHits, keywordHits]);
      const fusedCandidates = fused.slice(0, candidateLimit);
      timingsMs.fusion = Date.now() - fusionStartedAt;
      const candidateIds = fusedCandidates.map((hit) => hit.id);
      if (candidateIds.length === 0) {
        const durationMs = Date.now() - startedAt;
        timingsMs.total = durationMs;
        const response = this.emptyResponse(input, durationMs);
        if (input.includeDiagnostics) {
          response.diagnostics = buildDiagnostics(
            candidateLimit,
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
               document.title,
               chunk.content,
               chunk.anchor_type AS "anchorType",
               chunk.page_no AS "pageNo",
               chunk.slide_no AS "slideNo",
               chunk.sheet_name AS "sheetName",
               chunk.row_start AS "rowStart",
               chunk.row_end AS "rowEnd",
               chunk.heading,
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
        ],
      );
      timingsMs.hydration = Date.now() - hydrationStartedAt;
      const byId = new Map(rows.map((row) => [row.chunkId, row]));
      const hits = hydrateRankedHits(fusedCandidates, byId);
      const rerankStartedAt = Date.now();
      const reranked = await this.reranker.rerank({
        model: this.config.getOrThrow('RERANKER_MODEL'),
        query: input.text,
        documents: hits.map((hit) => ({ id: hit.chunkId, text: `${hit.title}\n${hit.content}` })),
        topN: candidateLimit,
        signal: input.signal,
        context: modelCallContext(input),
      });
      timingsMs.rerank = Date.now() - rerankStartedAt;
      const hitsById = new Map(hits.map((hit) => [hit.chunkId, hit]));
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
                  contentSha256: row.contentSha256,
                  embedding: parseVectorLiteral(row.embedding),
                },
              ]
            : [];
        }),
        nearDuplicateThreshold,
      );
      timingsMs.consolidation = Date.now() - consolidationStartedAt;
      const mmrStartedAt = Date.now();
      const rankedHits = maximalMarginalRelevance(
        consolidation.candidates.map((candidate) => ({
          id: candidate.hit.chunkId,
          relevanceScore: candidate.hit.score,
          embedding: candidate.embedding,
          hit: candidate.hit,
        })),
        { lambda: mmrLambda },
      ).map((candidate) => candidate.hit);
      timingsMs.mmr = Date.now() - mmrStartedAt;
      const offset = (input.page - 1) * input.limit;
      const durationMs = Date.now() - startedAt;
      timingsMs.total = durationMs;
      const candidateIdSet = new Set(candidateIds);
      const candidateRows = rows.filter((row) => candidateIdSet.has(row.chunkId));
      const response: SearchDocumentsResponse = {
        queryEventId: null,
        query: input.text,
        hits: rankedHits.slice(offset, offset + input.limit),
        total: rankedHits.length,
        page: input.page,
        pageSize: input.limit,
        durationMs,
        facets: buildFacets(candidateRows),
      };
      if (input.includeDiagnostics) {
        response.diagnostics = buildDiagnostics(
          candidateLimit,
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
          errorCode(error),
        );
      }
      throw error;
    }
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

  private emptyResponse(input: SearchCommand, durationMs: number): SearchDocumentsResponse {
    return {
      queryEventId: null,
      query: input.text,
      hits: [],
      total: 0,
      page: input.page,
      pageSize: input.limit,
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
          pageSize: input.limit,
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
  return ranking
    .map((ranked) => {
      const row = byId.get(ranked.id);
      if (!row) return null;
      return {
        chunkId: row.chunkId,
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        title: row.title,
        content: row.content,
        score: ranked.score,
        source: {
          type: row.anchorType,
          page: row.pageNo,
          slide: row.slideNo,
          sheet: row.sheetName,
          rowStart: row.rowStart,
          rowEnd: row.rowEnd,
          heading: row.heading,
          offsetStart: row.offsetStart,
          offsetEnd: row.offsetEnd,
        },
      } satisfies SearchDocumentHit;
    })
    .filter((hit): hit is SearchDocumentHit => hit !== null);
}

function buildDiagnostics(
  candidateLimit: number,
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
  byId: Map<string, ChunkRow>,
): SearchDiagnostics {
  const stage = (ranking: RankedChunk[]) => ({
    candidateCount: ranking.length,
    hits: hydrateRankedHits(ranking, byId),
  });
  return {
    candidateLimit,
    scoreThreshold,
    mmrLambda,
    nearDuplicateThreshold,
    consolidation,
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

export function reciprocalRankFusion(rankings: RankedChunk[][], rankConstant = 60): RankedChunk[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (rankConstant + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}
