import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type { ModelCallMetric, ModelCallObserver } from '@knowledge-base/model-gateway';
import { logEvent } from '@knowledge-base/observability';

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

  constructor(@Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>) {}

  readonly observe: ModelCallObserver = (metric) => {
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
