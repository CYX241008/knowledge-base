import { describe, expect, it, vi } from 'vitest';
import {
  maxChunksPerDocumentForSource,
  prepareRerankCandidates,
  reciprocalRankFusion,
  SearchService,
} from './search.service';

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

describe('search candidate policy', () => {
  it('only applies the per-document cap to answer retrieval', () => {
    expect(maxChunksPerDocumentForSource('answer', 3, 200)).toBe(3);
    expect(maxChunksPerDocumentForSource('search', 3, 200)).toBe(200);
    expect(maxChunksPerDocumentForSource(undefined, 3, 200)).toBe(200);
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
      MODEL_TOKENIZER_ENCODING: 'o200k_base',
      RAG_RERANK_CANDIDATE_LIMIT: 20,
      RAG_RERANK_MAX_TOKENS: 30_000,
      RAG_MAX_CHUNKS_PER_DOCUMENT: 3,
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
    expect(queries[0]).toContain('chunk.embedding_model = $8');
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
      MODEL_TOKENIZER_ENCODING: 'o200k_base',
      RAG_RERANK_CANDIDATE_LIMIT: 20,
      RAG_RERANK_MAX_TOKENS: 30_000,
      RAG_MAX_CHUNKS_PER_DOCUMENT: 3,
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

describe('prepareRerankCandidates', () => {
  it('deduplicates content and caps chunks from the same document before reranking', () => {
    const first = searchHit('11111111-1111-4111-8111-111111111111', 'document-a', 'first');
    const duplicate = searchHit('22222222-2222-4222-8222-222222222222', 'document-b', 'duplicate');
    const sameDocument = searchHit(
      '33333333-3333-4333-8333-333333333333',
      'document-a',
      'same document',
    );
    const result = prepareRerankCandidates(
      'query',
      [
        { hit: first, contentSha256: 'same-hash' },
        { hit: duplicate, contentSha256: 'same-hash' },
        { hit: sameDocument, contentSha256: 'other-hash' },
      ],
      {
        model: 'gpt-4o-mini',
        tokenizerEncoding: 'o200k_base',
        candidateLimit: 10,
        maxTokens: 1_000,
        maxChunksPerDocument: 1,
      },
    );

    expect(result.hits).toEqual([first]);
    expect(result.stats).toMatchObject({
      inputCandidates: 3,
      selectedCandidates: 1,
      exactDuplicatesRemoved: 1,
      perDocumentLimitRemoved: 1,
    });
  });

  it('truncates reranker input to the configured token budget', () => {
    const candidate = searchHit(
      '55555555-5555-4555-8555-555555555555',
      'document-a',
      'long evidence '.repeat(200),
    );
    const result = prepareRerankCandidates(
      'query',
      [{ hit: candidate, contentSha256: 'long-hash' }],
      {
        model: 'gpt-4o-mini',
        tokenizerEncoding: 'o200k_base',
        candidateLimit: 10,
        maxTokens: 40,
        maxChunksPerDocument: 3,
      },
    );

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.text.length).toBeLessThan(
      `${candidate.title}\n${candidate.content}`.length,
    );
    expect(result.stats.truncatedDocuments).toBe(1);
    expect(result.stats.inputTokens).toBeLessThanOrEqual(40);
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

function searchHit(chunkId: string, documentId: string, content: string) {
  return {
    chunkId,
    documentId,
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    title: 'Candidate',
    content,
    score: 1,
    source: {
      type: 'document' as const,
      page: null,
      slide: null,
      sheet: null,
      rowStart: null,
      rowEnd: null,
      heading: null,
      offsetStart: 0,
      offsetEnd: content.length,
    },
  };
}
