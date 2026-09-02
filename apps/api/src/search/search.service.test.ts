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
      ELASTICSEARCH_URL: 'http://search:9200',
      ELASTICSEARCH_INDEX: 'chunks',
      MODEL_MAX_CONCURRENCY: 8,
      MODEL_MAX_QUEUE_SIZE: 100,
      MODEL_REQUESTS_PER_MINUTE: 600,
      MODEL_MAX_RETRIES: 2,
      MODEL_RETRY_BASE_DELAY_MS: 250,
      MODEL_CIRCUIT_FAILURE_THRESHOLD: 5,
      MODEL_CIRCUIT_RESET_MS: 30_000,
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
