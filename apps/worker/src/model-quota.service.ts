import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildRedisUrl, type ServerEnv } from '@knowledge-base/config';
import {
  LocalModelCircuitBreaker,
  RedisModelCircuitBreaker,
  RedisModelRateLimiter,
  type ModelCircuitBreaker,
  type ModelRateLimiter,
} from '@knowledge-base/model-gateway';
import { logEvent } from '@knowledge-base/observability';

@Injectable()
export class ModelQuotaService implements OnModuleDestroy {
  readonly rateLimiter: ModelRateLimiter | undefined;
  readonly circuitBreaker: ModelCircuitBreaker;
  private readonly redisRateLimiter: RedisModelRateLimiter | undefined;
  private readonly redisCircuitBreaker: RedisModelCircuitBreaker | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<ServerEnv, true>) {
    if (config.getOrThrow('MODEL_RATE_LIMIT_BACKEND') !== 'redis') {
      this.circuitBreaker = new LocalModelCircuitBreaker();
      return;
    }
    const redisOptions = {
      url: buildRedisUrl({
        REDIS_URL: config.get('REDIS_URL'),
        REDIS_HOST: config.getOrThrow('REDIS_HOST'),
        REDIS_PORT: config.getOrThrow('REDIS_PORT'),
      }),
      namespace: config.getOrThrow('MODEL_RATE_LIMIT_NAMESPACE'),
      failOpen: config.getOrThrow('MODEL_RATE_LIMIT_FAIL_OPEN'),
    };
    this.redisRateLimiter = new RedisModelRateLimiter({
      ...redisOptions,
      onError: (error) =>
        logEvent('model.quota_error', {
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    this.redisCircuitBreaker = new RedisModelCircuitBreaker({
      ...redisOptions,
      onError: (error) =>
        logEvent('model.circuit_error', {
          message: error instanceof Error ? error.message : String(error),
        }),
    });
    this.rateLimiter = this.redisRateLimiter;
    this.circuitBreaker = this.redisCircuitBreaker;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.redisRateLimiter?.close(), this.redisCircuitBreaker?.close()]);
  }
}
