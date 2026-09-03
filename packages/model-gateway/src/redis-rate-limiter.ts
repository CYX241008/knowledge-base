import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type {
  ModelQuotaReservation,
  ModelRateLimitDecision,
  ModelRateLimiter,
  ModelRateLimitInput,
} from './index.js';

const RESERVE_FIXED_WINDOW_SCRIPT = `
local window = tonumber(ARGV[1])
for index = 1, #KEYS do
  local increment = tonumber(ARGV[index * 2])
  local limit = tonumber(ARGV[index * 2 + 1])
  local current = tonumber(redis.call('GET', KEYS[index]) or '0')
  if limit > 0 and current + increment > limit then
    local ttl = redis.call('PTTL', KEYS[index])
    if ttl < 1 then ttl = window end
    return { 0, ttl }
  end
end

for index = 1, #KEYS do
  local increment = tonumber(ARGV[index * 2])
  local next = redis.call('INCRBY', KEYS[index], increment)
  if next == increment then redis.call('PEXPIRE', KEYS[index], window) end
end
return { 1, window }
`;

const SETTLE_FIXED_WINDOW_SCRIPT = `
local delta = tonumber(ARGV[1])
if delta == 0 then return 0 end
for index = 1, #KEYS do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    local current = tonumber(redis.call('GET', KEYS[index]) or '0')
    local next = current + delta
    if next < 0 then next = 0 end
    redis.call('SET', KEYS[index], next, 'KEEPTTL')
  end
end
return #KEYS
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
  private readonly reservations = new Map<string, { keys: string[]; reservedTokens: number }>();

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
    const estimatedTokens = Math.max(0, Math.floor(input.estimatedTokens ?? 0));
    const entries = this.quotaEntries(input).filter((entry) => entry.limit > 0 && entry.amount > 0);
    if (entries.length === 0) return { allowed: true };
    try {
      const result = await this.client.eval(
        RESERVE_FIXED_WINDOW_SCRIPT,
        entries.length,
        ...entries.map((entry) => entry.key),
        this.windowMs,
        ...entries.flatMap((entry) => [entry.amount, entry.limit]),
      );
      if (!Array.isArray(result) || result.length < 2) {
        throw new Error('Redis model quota returned an invalid response');
      }
      const allowed = Number(result[0]);
      const ttl = Math.max(1, Number(result[1]));
      if (!Number.isFinite(allowed) || !Number.isFinite(ttl)) {
        throw new Error('Redis model quota returned non-numeric values');
      }
      if (allowed !== 1) return { allowed: false, retryAfterMs: ttl };
      const tokenKeys = entries.filter((entry) => entry.kind === 'token').map((entry) => entry.key);
      if (tokenKeys.length === 0 || estimatedTokens === 0) return { allowed: true };
      const reservation = { id: randomUUID(), reservedTokens: estimatedTokens };
      this.reservations.set(reservation.id, { keys: tokenKeys, reservedTokens: estimatedTokens });
      return { allowed: true, reservation };
    } catch (error) {
      this.options.onError?.(error);
      if (this.options.failOpen) return { allowed: true };
      throw error;
    }
  }

  async settle(reservation: ModelQuotaReservation, actualTokens: number): Promise<void> {
    const stored = this.reservations.get(reservation.id);
    if (!stored) return;
    this.reservations.delete(reservation.id);
    const delta = Math.max(0, Math.floor(actualTokens)) - stored.reservedTokens;
    if (delta === 0) return;
    try {
      await this.client.eval(SETTLE_FIXED_WINDOW_SCRIPT, stored.keys.length, ...stored.keys, delta);
    } catch (error) {
      this.options.onError?.(error);
      if (!this.options.failOpen) throw error;
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

  private quotaEntries(input: ModelRateLimitInput): Array<{
    key: string;
    kind: 'request' | 'token';
    amount: number;
    limit: number;
  }> {
    const prefix = `${this.namespace}:{model-quota}`;
    const estimatedTokens = Math.max(0, Math.floor(input.estimatedTokens ?? 0));
    const tokenLimits = input.tokenLimits;
    return [
      {
        key: `${prefix}:${input.operation}:${encodeURIComponent(input.model)}`,
        kind: 'request',
        amount: 1,
        limit: Math.max(0, Math.floor(input.limit)),
      },
      {
        key: `${prefix}:tpm:global`,
        kind: 'token',
        amount: estimatedTokens,
        limit: Math.max(0, Math.floor(tokenLimits?.global ?? 0)),
      },
      {
        key: `${prefix}:tpm:tenant:${encodeURIComponent(input.context?.tenantId ?? 'unknown')}`,
        kind: 'token',
        amount: estimatedTokens,
        limit: input.context?.tenantId ? Math.max(0, Math.floor(tokenLimits?.tenant ?? 0)) : 0,
      },
      {
        key: `${prefix}:tpm:user:${encodeURIComponent(input.context?.tenantId ?? 'unknown')}:${encodeURIComponent(input.context?.userId ?? 'unknown')}`,
        kind: 'token',
        amount: estimatedTokens,
        limit:
          input.context?.tenantId && input.context.userId
            ? Math.max(0, Math.floor(tokenLimits?.user ?? 0))
            : 0,
      },
      {
        key: `${prefix}:tpm:model:${input.operation}:${encodeURIComponent(input.model)}`,
        kind: 'token',
        amount: estimatedTokens,
        limit: Math.max(0, Math.floor(tokenLimits?.model[input.operation] ?? 0)),
      },
    ];
  }
}
