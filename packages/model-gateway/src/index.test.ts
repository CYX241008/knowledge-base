import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_HASH_EMBEDDING_DIMENSIONS,
  LOCAL_HASH_EMBEDDING_MODEL,
  LOCAL_LEXICAL_RERANKER_MODEL,
  LocalHashEmbeddingGateway,
  LocalLexicalRerankGateway,
  ModelGatewayOverloadedError,
  ModelGatewayRateLimitError,
  ModelGatewayUnavailableError,
  OpenAICompatibleModelGateway,
  type ModelCallMetric,
} from './index';

describe('LocalHashEmbeddingGateway', () => {
  it('produces deterministic normalized vectors', async () => {
    const gateway = new LocalHashEmbeddingGateway();
    const [first, second] = await gateway.embed({
      model: LOCAL_HASH_EMBEDDING_MODEL,
      inputs: ['PostgreSQL 向量检索', 'PostgreSQL 向量检索'],
    });

    expect(first).toEqual(second);
    expect(first).toHaveLength(LOCAL_HASH_EMBEDDING_DIMENSIONS);
    expect(Math.sqrt((first ?? []).reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
  });

  it('keeps related text closer than unrelated text', async () => {
    const gateway = new LocalHashEmbeddingGateway();
    const [query, related, unrelated] = await gateway.embed({
      model: LOCAL_HASH_EMBEDDING_MODEL,
      inputs: ['向量检索', '知识库向量检索方案', '幻灯片颜色主题'],
    });
    const similarity = (left: number[], right: number[]) =>
      left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);

    expect(similarity(query ?? [], related ?? [])).toBeGreaterThan(
      similarity(query ?? [], unrelated ?? []),
    );
  });
});

describe('OpenAICompatibleModelGateway', () => {
  it('requests configured dimensions and preserves embedding order', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      dimensions: 2,
      fetcher,
    });

    await expect(gateway.embed({ model: 'embedding-model', inputs: ['a', 'b'] })).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ dimensions: 2 });
  });

  it('parses streamed chat completion events', async () => {
    const metrics: ModelCallMetric[] = [];
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
              'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n' +
              'data: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    });
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
      onMetric: (metric) => metrics.push(metric),
    });
    const tokens: string[] = [];
    for await (const token of gateway.streamChat({
      model: 'chat-model',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      tokens.push(token);
    }
    expect(tokens).toEqual(['hello', ' world']);
    expect(metrics).toEqual([
      expect.objectContaining({
        operation: 'chat',
        status: 'success',
        attempts: 1,
        outputCharacters: 11,
        firstTokenDurationMs: expect.any(Number),
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      }),
    ]);
  });

  it('retries transient responses before reporting one successful call', async () => {
    const metrics: ModelCallMetric[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 3 } }),
      );
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      dimensions: 2,
      fetcher,
      retryBaseDelayMs: 0,
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(gateway.embed({ model: 'embedding-model', inputs: ['retry'] })).resolves.toEqual([
      [1, 0],
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(metrics[0]).toMatchObject({ status: 'success', attempts: 2 });
  });

  it('opens the circuit after the configured transient failure threshold', async () => {
    const metrics: ModelCallMetric[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('unavailable', { status: 503 }));
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      dimensions: 2,
      fetcher,
      maxRetries: 0,
      circuitFailureThreshold: 1,
      circuitResetMs: 60_000,
      onMetric: (metric) => metrics.push(metric),
    });

    await expect(gateway.embed({ model: 'embedding-model', inputs: ['first'] })).rejects.toThrow(
      '503',
    );
    await expect(
      gateway.embed({ model: 'embedding-model', inputs: ['second'] }),
    ).rejects.toBeInstanceOf(ModelGatewayUnavailableError);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(metrics.map((metric) => metric.status)).toEqual(['error', 'rejected']);
  });

  it('bounds concurrent work and its waiting queue', async () => {
    let releaseFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      dimensions: 2,
      fetcher,
      maxConcurrency: 1,
      maxQueueSize: 1,
    });

    const first = gateway.embed({ model: 'embedding-model', inputs: ['first'] });
    const second = gateway.embed({ model: 'embedding-model', inputs: ['second'] });
    await expect(
      gateway.embed({ model: 'embedding-model', inputs: ['third'] }),
    ).rejects.toBeInstanceOf(ModelGatewayOverloadedError);
    releaseFirst?.(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    await expect(Promise.all([first, second])).resolves.toEqual([[[1, 0]], [[1, 0]]]);
  });

  it('rejects requests above the configured per-minute limit before fetching', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      dimensions: 2,
      fetcher,
      requestsPerMinute: 1,
    });

    await expect(gateway.embed({ model: 'embedding-model', inputs: ['first'] })).resolves.toEqual([
      [1, 0],
    ]);
    await expect(
      gateway.embed({ model: 'embedding-model', inputs: ['second'] }),
    ).rejects.toBeInstanceOf(ModelGatewayRateLimitError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not start a cancelled model request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const metrics: ModelCallMetric[] = [];
    const gateway = new OpenAICompatibleModelGateway({
      baseUrl: 'https://models.example/v1',
      apiKey: 'secret',
      fetcher,
      onMetric: (metric) => metrics.push(metric),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      gateway.embed({ model: 'embedding-model', inputs: ['cancel'], signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(metrics[0]).toMatchObject({ status: 'cancelled', attempts: 0 });
  });
});

describe('LocalLexicalRerankGateway', () => {
  it('moves stronger evidence ahead of the initial ranking', async () => {
    const gateway = new LocalLexicalRerankGateway();
    const result = await gateway.rerank({
      model: LOCAL_LEXICAL_RERANKER_MODEL,
      query: '向量检索',
      documents: [
        { id: 'weak', text: '文档管理' },
        { id: 'strong', text: '知识库向量检索' },
      ],
      topN: 2,
    });
    expect(result[0]?.id).toBe('strong');
  });

  it('returns zero relevance when evidence has no lexical overlap', async () => {
    const gateway = new LocalLexicalRerankGateway();
    const [result] = await gateway.rerank({
      model: LOCAL_LEXICAL_RERANKER_MODEL,
      query: 'uniqueneedle2026',
      documents: [{ id: 'unrelated', text: 'PostgreSQL document storage' }],
      topN: 1,
    });

    expect(result?.score).toBe(0);
  });
});
