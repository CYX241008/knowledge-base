import { describe, expect, it, vi } from 'vitest';
import { reciprocalRankFusion, SearchService } from './search.service';

describe('reciprocalRankFusion', () => {
  it('rewards chunks returned by both retrievers', () => {
    const result = reciprocalRankFusion([
      [
        { id: 'vector-only', score: 0.9 },
        { id: 'shared', score: 0.8 },
      ],
      [
        { id: 'keyword-only', score: 10 },
        { id: 'shared', score: 8 },
      ],
    ]);

    expect(result[0]?.id).toBe('shared');
    expect(result).toHaveLength(3);
  });
});

describe('SearchService publication filtering', () => {
  it('requires published documents in vector retrieval', async () => {
    const queries: string[] = [];
    const dataSource = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return [];
      }),
      getRepository: vi.fn(() => ({ save: vi.fn(async () => undefined) })),
    };
    const values: Record<string, unknown> = {
      EMBEDDING_MODEL: 'local-hash-v1',
      EMBEDDING_DIMENSIONS: 384,
      MODEL_PROVIDER: 'local',
      MODEL_REQUEST_TIMEOUT_MS: 60_000,
      RERANKER_PROVIDER: 'local',
      RERANKER_MODEL: 'local-lexical-v1',
      RAG_MMR_LAMBDA: 0.7,
      RAG_NEAR_DUPLICATE_THRESHOLD: 0.92,
      ELASTICSEARCH_URL: 'http://search:9200',
      ELASTICSEARCH_INDEX: 'chunks',
      MODEL_MAX_CONCURRENCY: 8,
      MODEL_MAX_QUEUE_SIZE: 100,
      MODEL_REQUESTS_PER_MINUTE: 600,
      MODEL_MAX_RETRIES: 2,
      MODEL_RETRY_BASE_DELAY_MS: 250,
      MODEL_CIRCUIT_FAILURE_THRESHOLD: 5,
      MODEL_CIRCUIT_RESET_MS: 30_000,
      MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS: 1,
      MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD: 2,
      MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS: 90_000,
      MODEL_STREAM_INCLUDE_USAGE: true,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
      get: vi.fn((key: string) => values[key]),
    };
    const service = new SearchService(
      dataSource as never,
      config as never,
      { observe: vi.fn() } as never,
      undefined,
      {
        effectiveSettings: vi.fn(async () => ({
          candidateLimit: 20,
          scoreThreshold: 0,
          defaultPageSize: 10,
          feedbackEnabled: true,
          auditRetentionDays: 365,
        })),
      } as never,
    );
    (
      service as unknown as {
        keywordIndex: {
          search: (...args: unknown[]) => Promise<Array<{ id: string; score: number }>>;
        };
      }
    ).keywordIndex = {
      search: vi.fn(async () => [] as Array<{ id: string; score: number }>),
    };

    await service.search({
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      principalIds: ['tenant:11111111-1111-4111-8111-111111111111'],
      text: 'publication boundary',
      page: 1,
      limit: 10,
    });

    expect(queries[0]).toContain("document.status = 'published'");
  });
});

describe('SearchService MMR diversification', () => {
  it('uses stored embeddings to move redundant hits behind distinct evidence', async () => {
    const primaryId = '33333333-3333-4333-8333-333333333333';
    const duplicateId = '44444444-4444-4444-8444-444444444444';
    const diverseId = '55555555-5555-4555-8555-555555555555';
    const queries: string[] = [];
    const dataSource = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (queries.length === 1) {
          return [
            { id: primaryId, score: 0.9 },
            { id: duplicateId, score: 0.85 },
            { id: diverseId, score: 0.8 },
          ];
        }
        return [
          chunkRow(primaryId, 'Primary evidence', '[1,0]', 'document-1'),
          chunkRow(duplicateId, 'Repeated evidence', '[0.99,0.01]', 'document-2'),
          chunkRow(diverseId, 'Distinct evidence', '[0,1]', 'document-3'),
        ];
      }),
      getRepository: vi.fn(() => ({ save: vi.fn(async () => undefined) })),
    };
    const values: Record<string, unknown> = {
      EMBEDDING_MODEL: 'local-hash-v1',
      EMBEDDING_DIMENSIONS: 384,
      MODEL_PROVIDER: 'local',
      MODEL_REQUEST_TIMEOUT_MS: 60_000,
      RERANKER_PROVIDER: 'local',
      RERANKER_MODEL: 'local-lexical-v1',
      RAG_MMR_LAMBDA: 0.6,
      RAG_NEAR_DUPLICATE_THRESHOLD: 0.92,
      ELASTICSEARCH_URL: 'http://search:9200',
      ELASTICSEARCH_INDEX: 'chunks',
      MODEL_MAX_CONCURRENCY: 8,
      MODEL_MAX_QUEUE_SIZE: 100,
      MODEL_REQUESTS_PER_MINUTE: 600,
      MODEL_MAX_RETRIES: 2,
      MODEL_RETRY_BASE_DELAY_MS: 250,
      MODEL_CIRCUIT_FAILURE_THRESHOLD: 5,
      MODEL_CIRCUIT_RESET_MS: 30_000,
      MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS: 1,
      MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD: 2,
      MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS: 90_000,
      MODEL_STREAM_INCLUDE_USAGE: true,
    };
    const config = {
      getOrThrow: vi.fn((key: string) => values[key]),
      get: vi.fn((key: string) => values[key]),
    };
    const service = new SearchService(
      dataSource as never,
      config as never,
      { observe: vi.fn() } as never,
      undefined,
      {
        effectiveSettings: vi.fn(async () => ({
          candidateLimit: 20,
          scoreThreshold: 0,
          defaultPageSize: 10,
          feedbackEnabled: true,
          auditRetentionDays: 365,
        })),
      } as never,
    );
    (
      service as unknown as {
        keywordIndex: {
          search: (...args: unknown[]) => Promise<Array<{ id: string; score: number }>>;
        };
        reranker: {
          rerank: () => Promise<Array<{ id: string; score: number }>>;
        };
      }
    ).keywordIndex = {
      search: vi.fn(async () => []),
    };
    (
      service as unknown as {
        reranker: {
          rerank: () => Promise<Array<{ id: string; score: number }>>;
        };
      }
    ).reranker = {
      rerank: vi.fn(async () => [
        { id: primaryId, score: 1 },
        { id: duplicateId, score: 0.95 },
        { id: diverseId, score: 0.8 },
      ]),
    };

    const result = await service.search({
      tenantId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      principalIds: ['tenant:11111111-1111-4111-8111-111111111111'],
      text: 'diversify evidence',
      page: 1,
      limit: 3,
      includeDiagnostics: true,
      recordQuery: false,
    });

    expect(result.hits.map((hit) => hit.chunkId)).toEqual([primaryId, diverseId, duplicateId]);
    expect(result.hits.map((hit) => hit.score)).toEqual([1, 0.8, 0.95]);
    expect(result.diagnostics?.mmrLambda).toBe(0.6);
    expect(result.diagnostics?.consolidation.crossSourceSimilarPreserved).toBe(1);
    expect(queries[1]).toContain('chunk.embedding::text AS embedding');
  });
});

function chunkRow(chunkId: string, content: string, embedding: string, documentId: string) {
  return {
    chunkId,
    documentId,
    documentVersionId: `version-${documentId}`,
    ordinal: 1,
    contentSha256: `${chunkId}-hash`,
    title: 'MMR test',
    content,
    anchorType: 'document',
    pageNo: null,
    slideNo: null,
    sheetName: null,
    rowStart: null,
    rowEnd: null,
    heading: null,
    offsetStart: 0,
    offsetEnd: content.length,
    spaceId: null,
    folderId: null,
    tagIds: [],
    embedding,
  };
}
