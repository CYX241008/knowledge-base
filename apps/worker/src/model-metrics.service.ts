import { Inject, Injectable } from '@nestjs/common';
import { ModelUsageEventEntity } from '@knowledge-base/database';
import type { ModelCallObserver } from '@knowledge-base/model-gateway';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ModelPricingService } from './model-pricing.service';
import { ModelBudgetService } from './model-budget.service';

@Injectable()
export class ModelMetricsService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ModelPricingService) private readonly pricing: ModelPricingService,
    @Inject(ModelBudgetService) private readonly budget: ModelBudgetService,
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
    const price = this.pricing.resolve(metric.operation, metric.model);
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
            (attempt.usage.inputTokens * price.inputCostPerMillionTokens +
              attempt.usage.outputTokens * price.outputCostPerMillionTokens) /
            1_000_000,
          inputCostPerMillionTokens: price.inputCostPerMillionTokens,
          outputCostPerMillionTokens: price.outputCostPerMillionTokens,
          pricingSource: price.source,
          attemptDurationMs: attempt.durationMs,
          callDurationMs: metric.durationMs,
          firstTokenDurationMs: metric.firstTokenDurationMs ?? null,
          errorCode: attempt.errorCode ?? null,
          documentVersionId: metric.context?.documentVersionId ?? null,
          pageNo: metric.context?.pageNo ?? null,
          assetId: metric.context?.assetId ?? null,
          toolName: metric.context?.toolName ?? null,
        })),
      );
    } catch (error) {
      logEvent('model.usage_persist_failed', {
        callId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (metric.context?.tenantId) {
      await this.budget.recordThresholds(metric.context.tenantId).catch((error) =>
        logEvent('model.budget_alert_failed', {
          callId,
          tenantId: metric.context?.tenantId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
}
