import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { ModelUsageEventEntity } from '@knowledge-base/database';
import type { ModelCallObserver } from '@knowledge-base/model-gateway';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

@Injectable()
export class ModelMetricsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
  ) {}

  readonly observe: ModelCallObserver = async (metric) => {
    const attempts =
      metric.attemptMetrics && metric.attemptMetrics.length > 0
        ? metric.attemptMetrics
        : [
            {
              attempt: 0,
              status: metric.status,
              durationMs: metric.durationMs,
              reservedTokens: metric.usage?.totalTokens ?? 0,
              usage: metric.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              usageSource: metric.usage ? ('provider' as const) : ('estimated' as const),
            },
          ];
    const inputRate = this.config.getOrThrow('MODEL_INPUT_COST_PER_MILLION_TOKENS');
    const outputRate = this.config.getOrThrow('MODEL_OUTPUT_COST_PER_MILLION_TOKENS');
    const callId = metric.callId ?? randomUUID();
    try {
      await this.dataSource.getRepository(ModelUsageEventEntity).insert(
        attempts.map((attempt) => ({
          id: randomUUID(),
          callId,
          tenantId: metric.context?.tenantId ?? null,
          userId: metric.context?.userId ?? null,
          runId: metric.context?.runId ?? null,
          source: metric.context?.source ?? null,
          operation: metric.operation,
          model: metric.model,
          attempt: attempt.attempt,
          callStatus: metric.status,
          attemptStatus: attempt.status,
          usageSource: attempt.usageSource,
          reservedTokens: attempt.reservedTokens,
          inputTokens: attempt.usage.inputTokens,
          outputTokens: attempt.usage.outputTokens,
          totalTokens: attempt.usage.totalTokens,
          estimatedCostUsd:
            (attempt.usage.inputTokens * inputRate + attempt.usage.outputTokens * outputRate) /
            1_000_000,
          attemptDurationMs: attempt.durationMs,
          callDurationMs: metric.durationMs,
          firstTokenDurationMs: metric.firstTokenDurationMs ?? null,
          errorCode: attempt.errorCode ?? null,
        })),
      );
    } catch (error) {
      logEvent('model.usage_persist_failed', {
        callId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
