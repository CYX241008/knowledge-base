import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  ModelCallObserver,
  ModelRateLimiter,
  ModelResilienceOptions,
} from '@knowledge-base/model-gateway';

export function modelRuntimeOptions(
  config: ConfigService<ServerEnv, true>,
  onMetric: ModelCallObserver,
  rateLimiter?: ModelRateLimiter,
): ModelResilienceOptions & { includeUsage: boolean } {
  return {
    maxConcurrency: config.getOrThrow('MODEL_MAX_CONCURRENCY'),
    maxQueueSize: config.getOrThrow('MODEL_MAX_QUEUE_SIZE'),
    requestsPerMinute: config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
    rateLimiter,
    maxRetries: config.getOrThrow('MODEL_MAX_RETRIES'),
    retryBaseDelayMs: config.getOrThrow('MODEL_RETRY_BASE_DELAY_MS'),
    circuitFailureThreshold: config.getOrThrow('MODEL_CIRCUIT_FAILURE_THRESHOLD'),
    circuitResetMs: config.getOrThrow('MODEL_CIRCUIT_RESET_MS'),
    includeUsage: config.getOrThrow('MODEL_STREAM_INCLUDE_USAGE'),
    onMetric,
  };
}
