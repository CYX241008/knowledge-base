import type { ServerEnv } from '@knowledge-base/config';
import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ModelMetricsService } from './model-metrics.service';

describe('ModelMetricsService', () => {
  it('aggregates statuses, retries, token usage, latency, and estimated cost', () => {
    const config = {
      getOrThrow: (key: keyof ServerEnv) => (key === 'MODEL_INPUT_COST_PER_MILLION_TOKENS' ? 2 : 8),
    } as ConfigService<ServerEnv, true>;
    const metrics = new ModelMetricsService(config);
    metrics.observe({
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
    metrics.observe({
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
});
