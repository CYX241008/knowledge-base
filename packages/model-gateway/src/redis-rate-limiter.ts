import { Redis } from 'ioredis';
import type { ModelRateLimitDecision, ModelRateLimiter, ModelRateLimitInput } from './index.js';

const FIXED_WINDOW_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return { count, ttl }
`;

export type RedisRateLimitClient = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect?(): void;
};

export type RedisModelRateLimiterOptions = {
  url: string;
  namespace?: string;
  windowMs?: number;
  failOpen?: boolean;
  client?: RedisRateLimitClient;
  onError?: (error: unknown) => void;
};

export class RedisModelRateLimiter implements ModelRateLimiter {
  private readonly client: RedisRateLimitClient;
  private readonly ownsClient: boolean;
  private readonly namespace: string;
  private readonly windowMs: number;

  constructor(private readonly options: RedisModelRateLimiterOptions) {
    this.ownsClient = !options.client;
    this.client =
      options.client ??
      new Redis(options.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
    this.namespace = (options.namespace ?? 'knowledge-base').replace(/[^a-zA-Z0-9:_-]/g, '_');
    this.windowMs = Math.max(1_000, Math.floor(options.windowMs ?? 60_000));
  }

  async consume(input: ModelRateLimitInput): Promise<ModelRateLimitDecision> {
    if (input.limit === 0) return { allowed: true };
    try {
      const key = `${this.namespace}:{model-quota}:${input.operation}:${encodeURIComponent(input.model)}`;
      const result = await this.client.eval(FIXED_WINDOW_SCRIPT, 1, key, this.windowMs);
      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Redis model quota returned an invalid response');
      }
      const count = Number(result[0]);
      const ttl = Math.max(1, Number(result[1]));
      if (!Number.isFinite(count) || !Number.isFinite(ttl)) {
        throw new Error('Redis model quota returned non-numeric values');
      }
      return count <= input.limit ? { allowed: true } : { allowed: false, retryAfterMs: ttl };
    } catch (error) {
      this.options.onError?.(error);
      if (this.options.failOpen) return { allowed: true };
      throw error;
    }
  }

  async checkConnection(): Promise<void> {
    const result = await this.client.ping();
    if (result !== 'PONG') throw new Error(`Redis quota ping returned ${result}`);
  }

  async close(): Promise<void> {
    if (!this.ownsClient) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect?.();
    }
  }
}
