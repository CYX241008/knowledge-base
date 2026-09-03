import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type {
  ModelCircuitBreaker,
  ModelCallObserver,
  ModelRateLimiter,
  ModelResilienceOptions,
} from '@knowledge-base/model-gateway';

export function modelRuntimeOptions(
  config: ConfigService<ServerEnv, true>,
  onMetric: ModelCallObserver,
  rateLimiter?: ModelRateLimiter,
  circuitBreaker?: ModelCircuitBreaker,
): ModelResilienceOptions & { includeUsage: boolean } {
  return {
    maxConcurrency: config.getOrThrow('MODEL_MAX_CONCURRENCY'),
    maxQueueSize: config.getOrThrow('MODEL_MAX_QUEUE_SIZE'),
    requestsPerMinute: config.getOrThrow('MODEL_REQUESTS_PER_MINUTE'),
    tokenRateLimits: {
      global: config.getOrThrow('MODEL_GLOBAL_TOKENS_PER_MINUTE'),
      tenant: config.getOrThrow('MODEL_TENANT_TOKENS_PER_MINUTE'),
      user: config.getOrThrow('MODEL_USER_TOKENS_PER_MINUTE'),
      model: {
        embedding: config.getOrThrow('MODEL_EMBEDDING_TOKENS_PER_MINUTE'),
        chat: config.getOrThrow('MODEL_CHAT_TOKENS_PER_MINUTE'),
        rerank: config.getOrThrow('MODEL_RERANK_TOKENS_PER_MINUTE'),
      },
    },
    rateLimiter,
    circuitBreaker,
    maxRetries: config.getOrThrow('MODEL_MAX_RETRIES'),
    retryBaseDelayMs: config.getOrThrow('MODEL_RETRY_BASE_DELAY_MS'),
    circuitFailureThreshold: config.getOrThrow('MODEL_CIRCUIT_FAILURE_THRESHOLD'),
    circuitResetMs: config.getOrThrow('MODEL_CIRCUIT_RESET_MS'),
    circuitHalfOpenMaxRequests: config.getOrThrow('MODEL_CIRCUIT_HALF_OPEN_MAX_REQUESTS'),
    circuitHalfOpenSuccessThreshold: config.getOrThrow('MODEL_CIRCUIT_HALF_OPEN_SUCCESS_THRESHOLD'),
    circuitHalfOpenProbeTimeoutMs: config.getOrThrow('MODEL_CIRCUIT_HALF_OPEN_PROBE_TIMEOUT_MS'),
    includeUsage: config.getOrThrow('MODEL_STREAM_INCLUDE_USAGE'),
    onMetric,
  };
}
