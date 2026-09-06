import { countModelTextTokens } from '@knowledge-base/model-gateway';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildEmbeddingBatches,
  isPublishedSearchVersion,
  SearchProjectionService,
} from './search-projection.service';

describe('published search projection boundary', () => {
  const oldVersionId = '11111111-1111-4111-8111-111111111111';
  const pendingVersionId = '22222222-2222-4222-8222-222222222222';

  it('does not expose a ready draft version', () => {
    expect(
      isPublishedSearchVersion(
        { status: 'draft', currentReadyVersionId: pendingVersionId },
        pendingVersionId,
      ),
    ).toBe(false);
  });

  it('keeps the old published version visible while a new version is pending review', () => {
    const document = { status: 'published' as const, currentReadyVersionId: oldVersionId };
    expect(isPublishedSearchVersion(document, oldVersionId)).toBe(true);
    expect(isPublishedSearchVersion(document, pendingVersionId)).toBe(false);
  });

  it('does not expose an archived document', () => {
    expect(
      isPublishedSearchVersion(
        { status: 'archived', currentReadyVersionId: oldVersionId },
        oldVersionId,
      ),
    ).toBe(false);
  });
});

describe('embedding batches', () => {
  it('limits both item count and aggregate tokens', () => {
    const batches = buildEmbeddingBatches(
      [
        { content: 'a', contentSha256: 'a', tokenCount: 4 },
        { content: 'b', contentSha256: 'b', tokenCount: 4 },
        { content: 'c', contentSha256: 'c', tokenCount: 9 },
      ],
      2,
      10,
    );

    expect(batches.map((batch) => batch.map((item) => item.contentSha256))).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('rejects one chunk that exceeds the embedding token limit', () => {
    expect(() =>
      buildEmbeddingBatches(
        [{ content: 'oversized', contentSha256: 'oversized', tokenCount: 11 }],
        64,
        10,
      ),
    ).toThrow('exceeding the batch limit');
  });

  it('reuses a cached embedding and stores the tokenizer token count', async () => {
    const content = 'Reusable cached content';
    const contextSummary = 'document_title: Reusable document';
    const contextualContent = `${contextSummary}\n\n${content}`;
    const contentSha256 = createHash('sha256').update(content).digest('hex');
    const embeddingInputSha256 = createHash('sha256').update(contextualContent).digest('hex');
    const vector = Array.from({ length: 384 }, () => 0);
    const saved: Array<Record<string, unknown>> = [];
    const chunkRepository = {
      create: vi.fn((value) => value),
    };
    const embeddingCacheRepository = {
      find: vi.fn(async () => [
        {
          tenantId: tenantId,
          contentSha256: embeddingInputSha256,
          embeddingModel: 'local-hash-v1',
          dimensions: 384,
          embedding: vector,
          tokenCount: 1,
        },
      ]),
      create: vi.fn((value) => value),
      upsert: vi.fn(),
    };
    const manager = {
      getRepository: vi.fn(() => ({
        delete: vi.fn(),
        save: vi.fn(async (records: Array<Record<string, unknown>>) => {
          saved.push(...records);
        }),
      })),
    };
    const service = new SearchProjectionService(
      {
        transaction: vi.fn(async (callback) => callback(manager)),
      } as never,
      config() as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      chunkRepository as never,
      embeddingCacheRepository as never,
      { rateLimiter: undefined, circuitBreaker: undefined } as never,
      { observe: vi.fn() } as never,
      { assertEmbeddingAllowed: vi.fn() } as never,
    );
    const embed = vi.fn();
    (service as unknown as { embedding: { embed: typeof embed } }).embedding = { embed };

    await service.buildChunks({
      document: {
        id: '22222222-2222-4222-8222-222222222222',
        tenantId,
        title: 'Reusable document',
        accessPrincipalIds: [`tenant:${tenantId}`],
      } as never,
      version: { id: versionId } as never,
      markdown: content,
      anchors: [],
    });

    expect(embed).not.toHaveBeenCalled();
    expect(embeddingCacheRepository.upsert).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({
      contentSha256,
      embeddingInputSha256,
      contextualContent,
      contextSummary,
      embedding: vector,
      tokenCount: countModelTextTokens('local-hash-v1', content, 'o200k_base'),
    });
  });
});

const tenantId = '11111111-1111-4111-8111-111111111111';
const versionId = '33333333-3333-4333-8333-333333333333';

function config() {
  const values: Record<string, unknown> = {
    EMBEDDING_MODEL: 'local-hash-v1',
    EMBEDDING_DIMENSIONS: 384,
    MODEL_PROVIDER: 'local',
    MODEL_REQUEST_TIMEOUT_MS: 60_000,
    MODEL_MAX_CONCURRENCY: 8,
    MODEL_MAX_QUEUE_SIZE: 100,
    MODEL_REQUESTS_PER_MINUTE: 600,
    MODEL_GLOBAL_TOKENS_PER_MINUTE: 0,
    MODEL_TENANT_TOKENS_PER_MINUTE: 0,
    MODEL_USER_TOKENS_PER_MINUTE: 0,
    MODEL_EMBEDDING_TOKENS_PER_MINUTE: 0,
    MODEL_CHAT_TOKENS_PER_MINUTE: 0,
    MODEL_RERANK_TOKENS_PER_MINUTE: 0,
    MODEL_TOKENIZER_ENCODING: 'o200k_base',
    MODEL_MAX_RETRIES: 2,
    MODEL_RETRY_BASE_DELAY_MS: 250,
    MODEL_CIRCUIT_FAILURE_THRESHOLD: 5,
    MODEL_CIRCUIT_RESET_MS: 30_000,
    MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS: 1,
    MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD: 2,
    MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS: 90_000,
    MODEL_STREAM_INCLUDE_USAGE: true,
    ELASTICSEARCH_URL: 'http://search:9200',
    ELASTICSEARCH_INDEX: 'chunks',
    DOCUMENT_MAX_CHUNKS: 10_000,
    RAG_CONTEXTUAL_RETRIEVAL_ENABLED: true,
    EMBEDDING_BATCH_MAX_INPUTS: 64,
    EMBEDDING_BATCH_MAX_TOKENS: 50_000,
  };
  return {
    getOrThrow: vi.fn((key: string) => values[key]),
    get: vi.fn((key: string) => values[key]),
  };
}
