import type { ServerEnv } from '@knowledge-base/config';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { ModelMetricsService } from './model-metrics.service';

describe('ModelMetricsService', () => {
  it('aggregates statuses, retries, token usage, latency, and estimated cost', () => {
    const config = {
      getOrThrow: (key: keyof ServerEnv) => (key === 'MODEL_INPUT_COST_PER_MILLION_TOKENS' ? 2 : 8),
    } as ConfigService<ServerEnv, true>;
    const metrics = new ModelMetricsService(config);
    void metrics.observe({
      operation: 'chat',
      model: 'answer-model',
      status: 'success',
      durationMs: 120,
      firstTokenDurationMs: 35,
      attempts: 2,
      inputCharacters: 400,
      outputCharacters: 80,
      usage: { inputTokens: 1_000, outputTokens: 250, totalTokens: 1_250 },
    });
    void metrics.observe({
      operation: 'chat',
      model: 'answer-model',
      status: 'cancelled',
      durationMs: 20,
      attempts: 1,
      inputCharacters: 100,
      outputCharacters: 10,
    });

    expect(metrics.snapshot().operations[0]).toMatchObject({
      calls: 2,
      success: 1,
      cancelled: 1,
      retries: 1,
      averageDurationMs: 70,
      firstTokenSamples: 1,
      averageFirstTokenDurationMs: 35,
      maxFirstTokenDurationMs: 35,
      inputTokens: 1_000,
      outputTokens: 250,
      totalTokens: 1_250,
      estimatedCostUsd: 0.004,
    });
  });

  it('persists every attempt with tenant and run context', async () => {
    const insert = vi.fn().mockResolvedValue(undefined);
    const dataSource = {
      getRepository: vi.fn(() => ({ insert })),
    };
    const config = {
      getOrThrow: (key: keyof ServerEnv) => (key === 'MODEL_INPUT_COST_PER_MILLION_TOKENS' ? 2 : 8),
    } as ConfigService<ServerEnv, true>;
    const metrics = new ModelMetricsService(config, dataSource as never);

    await metrics.observe({
      callId: '33333333-3333-4333-8333-333333333333',
      operation: 'chat',
      model: 'answer-model',
      status: 'success',
      durationMs: 120,
      attempts: 2,
      inputCharacters: 400,
      outputCharacters: 80,
      context: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        runId: '44444444-4444-4444-8444-444444444444',
        source: 'answer',
      },
      usage: { inputTokens: 1_500, outputTokens: 250, totalTokens: 1_750 },
      attemptMetrics: [
        {
          attempt: 1,
          status: 'error',
          durationMs: 30,
          reservedTokens: 500,
          usage: { inputTokens: 400, outputTokens: 100, totalTokens: 500 },
          usageSource: 'reserved',
          errorCode: 'http_503',
        },
        {
          attempt: 2,
          status: 'success',
          durationMs: 90,
          reservedTokens: 1_500,
          usage: { inputTokens: 1_100, outputTokens: 150, totalTokens: 1_250 },
          usageSource: 'provider',
        },
      ],
    });

    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        callId: '33333333-3333-4333-8333-333333333333',
        tenantId: '11111111-1111-4111-8111-111111111111',
        runId: '44444444-4444-4444-8444-444444444444',
        attempt: 1,
        usageSource: 'reserved',
        totalTokens: 500,
        estimatedCostUsd: 0.0016,
      }),
      expect.objectContaining({
        attempt: 2,
        usageSource: 'provider',
        totalTokens: 1_250,
        estimatedCostUsd: 0.0034,
      }),
    ]);
  });

  it('queries durable usage by tenant and time window', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        operation: 'embedding',
        model: 'embedding-model',
        calls: '3',
        success: '2',
        errors: '1',
        cancelled: '0',
        rejected: '0',
        durationMs: '300',
        maxDurationMs: '150',
        firstTokenSamples: '0',
        firstTokenDurationMs: '0',
        maxFirstTokenDurationMs: '0',
        retries: '2',
        inputCharacters: '0',
        outputCharacters: '0',
        inputTokens: '900',
        outputTokens: '0',
        totalTokens: '900',
        estimatedCostUsd: '0.0018',
      },
    ]);
    const config = {
      getOrThrow: () => 0,
    } as unknown as ConfigService<ServerEnv, true>;
    const metrics = new ModelMetricsService(config, { query } as never);

    const snapshot = await metrics.usageForTenant('11111111-1111-4111-8111-111111111111', 7);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]?.[0]).toBe('11111111-1111-4111-8111-111111111111');
    expect(snapshot.operations[0]).toMatchObject({
      calls: 3,
      errors: 1,
      retries: 2,
      totalTokens: 900,
      estimatedCostUsd: 0.0018,
    });
  });
});
