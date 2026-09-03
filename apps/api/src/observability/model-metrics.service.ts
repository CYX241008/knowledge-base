import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { ModelUsageEventEntity } from '@knowledge-base/database';
import type { ModelCallMetric, ModelCallObserver } from '@knowledge-base/model-gateway';
import { logEvent } from '@knowledge-base/observability';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

type ModelMetricAccumulator = {
  operation: ModelCallMetric['operation'];
  model: string;
  calls: number;
  success: number;
  errors: number;
  cancelled: number;
  rejected: number;
  durationMs: number;
  maxDurationMs: number;
  firstTokenSamples: number;
  firstTokenDurationMs: number;
  maxFirstTokenDurationMs: number;
  retries: number;
  inputCharacters: number;
  outputCharacters: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

@Injectable()
export class ModelMetricsService {
  private readonly startedAt = new Date();
  private readonly accumulators = new Map<string, ModelMetricAccumulator>();

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Optional() @Inject(DataSource) private readonly dataSource?: DataSource,
  ) {}

  readonly observe: ModelCallObserver = async (metric) => {
    const key = `${metric.operation}:${metric.model}`;
    const accumulator = this.accumulators.get(key) ?? {
      operation: metric.operation,
      model: metric.model,
      calls: 0,
      success: 0,
      errors: 0,
      cancelled: 0,
      rejected: 0,
      durationMs: 0,
      maxDurationMs: 0,
      firstTokenSamples: 0,
      firstTokenDurationMs: 0,
      maxFirstTokenDurationMs: 0,
      retries: 0,
      inputCharacters: 0,
      outputCharacters: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    accumulator.calls += 1;
    accumulator[statusField(metric.status)] += 1;
    accumulator.durationMs += metric.durationMs;
    accumulator.maxDurationMs = Math.max(accumulator.maxDurationMs, metric.durationMs);
    if (metric.firstTokenDurationMs !== undefined) {
      accumulator.firstTokenSamples += 1;
      accumulator.firstTokenDurationMs += metric.firstTokenDurationMs;
      accumulator.maxFirstTokenDurationMs = Math.max(
        accumulator.maxFirstTokenDurationMs,
        metric.firstTokenDurationMs,
      );
    }
    accumulator.retries += Math.max(0, metric.attempts - 1);
    accumulator.inputCharacters += metric.inputCharacters;
    accumulator.outputCharacters += metric.outputCharacters;
    accumulator.inputTokens += metric.usage?.inputTokens ?? 0;
    accumulator.outputTokens += metric.usage?.outputTokens ?? 0;
    accumulator.totalTokens += metric.usage?.totalTokens ?? 0;
    this.accumulators.set(key, accumulator);

    if (metric.status !== 'success') {
      logEvent('model.call_non_success', {
        operation: metric.operation,
        model: metric.model,
        status: metric.status,
        attempts: metric.attempts,
        durationMs: metric.durationMs,
      });
    }
    await this.persist(metric);
  };

  snapshot(): {
    startedAt: string;
    operations: Array<
      ModelMetricAccumulator & {
        averageDurationMs: number;
        averageFirstTokenDurationMs: number | null;
        estimatedCostUsd: number;
      }
    >;
  } {
    const inputRate = this.config.getOrThrow('MODEL_INPUT_COST_PER_MILLION_TOKENS');
    const outputRate = this.config.getOrThrow('MODEL_OUTPUT_COST_PER_MILLION_TOKENS');
    return {
      startedAt: this.startedAt.toISOString(),
      operations: [...this.accumulators.values()]
        .map((metric) => ({
          ...metric,
          averageDurationMs: round(metric.durationMs / metric.calls, 2),
          averageFirstTokenDurationMs:
            metric.firstTokenSamples === 0
              ? null
              : round(metric.firstTokenDurationMs / metric.firstTokenSamples, 2),
          estimatedCostUsd: round(
            (metric.inputTokens * inputRate + metric.outputTokens * outputRate) / 1_000_000,
            6,
          ),
        }))
        .sort(
          (left, right) =>
            left.operation.localeCompare(right.operation) || left.model.localeCompare(right.model),
        ),
    };
  }

  async usageForTenant(
    tenantId: string,
    days: number,
  ): Promise<ReturnType<ModelMetricsService['snapshot']>> {
    if (!this.dataSource) return { startedAt: new Date().toISOString(), operations: [] };
    const startedAt = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
    const rows = await this.dataSource.query<
      Array<{
        operation: ModelCallMetric['operation'];
        model: string;
        calls: string;
        success: string;
        errors: string;
        cancelled: string;
        rejected: string;
        durationMs: string;
        maxDurationMs: string;
        firstTokenSamples: string;
        firstTokenDurationMs: string;
        maxFirstTokenDurationMs: string;
        retries: string;
        inputCharacters: string;
        outputCharacters: string;
        inputTokens: string;
        outputTokens: string;
        totalTokens: string;
        estimatedCostUsd: string;
      }>
    >(
      `
      WITH filtered AS (
        SELECT *
        FROM model_usage_event
        WHERE tenant_id = $1
          AND created_at >= $2
      ),
      calls AS (
        SELECT operation,
               model,
               call_id,
               MIN(call_status) AS call_status,
               MAX(call_duration_ms) AS call_duration_ms,
               MAX(first_token_duration_ms) AS first_token_duration_ms,
               GREATEST(MAX(attempt) - 1, 0) AS retries
        FROM filtered
        GROUP BY operation, model, call_id
      ),
      call_totals AS (
        SELECT operation,
               model,
               COUNT(*) AS calls,
               COUNT(*) FILTER (WHERE call_status = 'success') AS success,
               COUNT(*) FILTER (WHERE call_status = 'error') AS errors,
               COUNT(*) FILTER (WHERE call_status = 'cancelled') AS cancelled,
               COUNT(*) FILTER (WHERE call_status = 'rejected') AS rejected,
               SUM(call_duration_ms) AS "durationMs",
               MAX(call_duration_ms) AS "maxDurationMs",
               COUNT(first_token_duration_ms) AS "firstTokenSamples",
               COALESCE(SUM(first_token_duration_ms), 0) AS "firstTokenDurationMs",
               COALESCE(MAX(first_token_duration_ms), 0) AS "maxFirstTokenDurationMs",
               COALESCE(SUM(retries), 0) AS retries
        FROM calls
        GROUP BY operation, model
      ),
      usage_totals AS (
        SELECT operation,
               model,
               COALESCE(SUM(input_tokens), 0) AS "inputTokens",
               COALESCE(SUM(output_tokens), 0) AS "outputTokens",
               COALESCE(SUM(total_tokens), 0) AS "totalTokens",
               COALESCE(SUM(estimated_cost_usd), 0) AS "estimatedCostUsd"
        FROM filtered
        GROUP BY operation, model
      )
      SELECT call_totals.*,
             0 AS "inputCharacters",
             0 AS "outputCharacters",
             usage_totals."inputTokens",
             usage_totals."outputTokens",
             usage_totals."totalTokens",
             usage_totals."estimatedCostUsd"
      FROM call_totals
      INNER JOIN usage_totals USING (operation, model)
      ORDER BY operation, model
      `,
      [tenantId, startedAt],
    );
    return {
      startedAt: startedAt.toISOString(),
      operations: rows.map((row) => {
        const calls = Number(row.calls);
        const firstTokenSamples = Number(row.firstTokenSamples);
        return {
          operation: row.operation,
          model: row.model,
          calls,
          success: Number(row.success),
          errors: Number(row.errors),
          cancelled: Number(row.cancelled),
          rejected: Number(row.rejected),
          durationMs: Number(row.durationMs),
          maxDurationMs: Number(row.maxDurationMs),
          firstTokenSamples,
          firstTokenDurationMs: Number(row.firstTokenDurationMs),
          maxFirstTokenDurationMs: Number(row.maxFirstTokenDurationMs),
          retries: Number(row.retries),
          inputCharacters: Number(row.inputCharacters),
          outputCharacters: Number(row.outputCharacters),
          inputTokens: Number(row.inputTokens),
          outputTokens: Number(row.outputTokens),
          totalTokens: Number(row.totalTokens),
          averageDurationMs: calls === 0 ? 0 : round(Number(row.durationMs) / calls, 2),
          averageFirstTokenDurationMs:
            firstTokenSamples === 0
              ? null
              : round(Number(row.firstTokenDurationMs) / firstTokenSamples, 2),
          estimatedCostUsd: round(Number(row.estimatedCostUsd), 6),
        };
      }),
    };
  }

  private async persist(metric: ModelCallMetric): Promise<void> {
    if (!this.dataSource) return;
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
  }
}

function statusField(
  status: ModelCallMetric['status'],
): 'success' | 'errors' | 'cancelled' | 'rejected' {
  return status === 'error' ? 'errors' : status;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
