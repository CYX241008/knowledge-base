import { Redis } from 'ioredis';
import {
  LocalModelCircuitBreaker,
  type ModelCircuitBreaker,
  type ModelCircuitBreakerInput,
  type ModelCircuitDecision,
  type ModelCircuitPermit,
} from './circuit-breaker.js';

const ACQUIRE_SCRIPT = `
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local generation = tonumber(redis.call('HGET', KEYS[1], 'generation')) or 0
local currentTime = redis.call('TIME')
local now = tonumber(currentTime[1]) * 1000 + math.floor(tonumber(currentTime[2]) / 1000)

if state == 'open' then
  local openUntil = tonumber(redis.call('HGET', KEYS[1], 'open_until')) or 0
  if now < openUntil then
    return { 0, 1, generation, openUntil - now }
  end
  state = 'half-open'
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    state,
    'half_open_in_flight',
    0,
    'half_open_successes',
    0,
    'half_open_lease_until',
    0
  )
end

if state == 'half-open' then
  local inFlight = tonumber(redis.call('HGET', KEYS[1], 'half_open_in_flight')) or 0
  if inFlight >= tonumber(ARGV[1]) then
    local leaseUntil = tonumber(redis.call('HGET', KEYS[1], 'half_open_lease_until')) or 0
    if now < leaseUntil then
      return { 0, 2, generation, leaseUntil - now }
    end
    redis.call(
      'HSET',
      KEYS[1],
      'half_open_in_flight',
      0,
      'half_open_successes',
      0,
      'half_open_lease_until',
      0,
      'generation',
      generation + 1
    )
    generation = generation + 1
  end
  redis.call('HINCRBY', KEYS[1], 'half_open_in_flight', 1)
  redis.call('HSET', KEYS[1], 'half_open_lease_until', now + tonumber(ARGV[2]))
  return { 1, 2, generation, 0 }
end

return { 1, 0, generation, 0 }
`;

const SUCCEED_SCRIPT = `
local permitState = ARGV[1]
local permitGeneration = tonumber(ARGV[2])
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local generation = tonumber(redis.call('HGET', KEYS[1], 'generation')) or 0

if generation ~= permitGeneration then
  return 0
end

if permitState == 'closed' then
  if state == 'closed' then
    redis.call('HSET', KEYS[1], 'state', 'closed', 'failure_count', 0, 'generation', generation)
  end
  return 1
end

if state ~= 'half-open' then
  return 0
end

local inFlight = math.max(
  0,
  (tonumber(redis.call('HGET', KEYS[1], 'half_open_in_flight')) or 0) - 1
)
local successes = (tonumber(redis.call('HGET', KEYS[1], 'half_open_successes')) or 0) + 1
if successes >= tonumber(ARGV[3]) then
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'closed',
    'failure_count',
    0,
    'open_until',
    0,
    'half_open_in_flight',
    0,
    'half_open_successes',
    0,
    'half_open_lease_until',
    0,
    'generation',
    generation + 1
  )
else
  redis.call(
    'HSET',
    KEYS[1],
    'half_open_in_flight',
    inFlight,
    'half_open_successes',
    successes
  )
  if inFlight == 0 then
    redis.call('HSET', KEYS[1], 'half_open_lease_until', 0)
  end
end
return 1
`;

const FAIL_SCRIPT = `
local permitState = ARGV[1]
local permitGeneration = tonumber(ARGV[2])
local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local generation = tonumber(redis.call('HGET', KEYS[1], 'generation')) or 0

if generation ~= permitGeneration then
  return 0
end

local function openCircuit()
  local currentTime = redis.call('TIME')
  local now = tonumber(currentTime[1]) * 1000 + math.floor(tonumber(currentTime[2]) / 1000)
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'open',
    'failure_count',
    0,
    'open_until',
    now + tonumber(ARGV[4]),
    'half_open_in_flight',
    0,
    'half_open_successes',
    0,
    'half_open_lease_until',
    0,
    'generation',
    generation + 1
  )
end

if permitState == 'half-open' then
  if state == 'half-open' then
    openCircuit()
  end
  return 1
end

if state ~= 'closed' then
  return 0
end

local failures = (tonumber(redis.call('HGET', KEYS[1], 'failure_count')) or 0) + 1
if failures >= tonumber(ARGV[3]) then
  openCircuit()
else
  redis.call(
    'HSET',
    KEYS[1],
    'state',
    'closed',
    'failure_count',
    failures,
    'generation',
    generation
  )
end
return 1
`;

const RELEASE_SCRIPT = `
if ARGV[1] ~= 'half-open' then
  return 0
end

local state = redis.call('HGET', KEYS[1], 'state') or 'closed'
local generation = tonumber(redis.call('HGET', KEYS[1], 'generation')) or 0
if state ~= 'half-open' or generation ~= tonumber(ARGV[2]) then
  return 0
end

local inFlight = math.max(
  0,
  (tonumber(redis.call('HGET', KEYS[1], 'half_open_in_flight')) or 0) - 1
)
redis.call('HSET', KEYS[1], 'half_open_in_flight', inFlight)
if inFlight == 0 then
  redis.call('HSET', KEYS[1], 'half_open_lease_until', 0)
end
return 1
`;

export type RedisCircuitBreakerClient = {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect?(): void;
};

export type RedisModelCircuitBreakerOptions = {
  url: string;
  namespace?: string;
  failOpen?: boolean;
  client?: RedisCircuitBreakerClient;
  onError?: (error: unknown) => void;
};

export class RedisModelCircuitBreaker implements ModelCircuitBreaker {
  private readonly client: RedisCircuitBreakerClient;
  private readonly ownsClient: boolean;
  private readonly namespace: string;
  private readonly fallback = new LocalModelCircuitBreaker();

  constructor(private readonly options: RedisModelCircuitBreakerOptions) {
    this.ownsClient = !options.client;
    this.client =
      options.client ??
      new Redis(options.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      });
    this.namespace = (options.namespace ?? 'knowledge-base').replace(/[^a-zA-Z0-9:_-]/g, '_');
  }

  async acquire(input: ModelCircuitBreakerInput): Promise<ModelCircuitDecision> {
    try {
      const result = await this.client.eval(
        ACQUIRE_SCRIPT,
        1,
        this.key(input),
        normalizePositive(input.halfOpenMaxRequests),
        normalizePositive(input.halfOpenProbeTimeoutMs),
      );
      if (!Array.isArray(result) || result.length < 4) {
        throw new Error('Redis model circuit breaker returned an invalid response');
      }
      const allowed = Number(result[0]) === 1;
      const stateCode = Number(result[1]);
      const generation = Number(result[2]);
      const retryAfterMs = Math.max(0, Number(result[3]));
      if (![0, 1, 2].includes(stateCode) || !Number.isFinite(generation)) {
        throw new Error('Redis model circuit breaker returned non-numeric values');
      }
      if (!allowed) {
        return {
          allowed: false,
          state: stateCode === 1 ? 'open' : 'half-open',
          ...(stateCode === 1 && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
        };
      }
      return {
        allowed: true,
        permit: {
          state: stateCode === 2 ? 'half-open' : 'closed',
          generation,
        },
      };
    } catch (error) {
      this.options.onError?.(error);
      if (!this.options.failOpen) throw error;
      const decision = await this.fallback.acquire(input);
      return decision.allowed
        ? { allowed: true, permit: { ...decision.permit, fallback: true } }
        : decision;
    }
  }

  async succeed(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    if (permit.fallback) {
      await this.fallback.succeed(input, permit);
      return;
    }
    await this.report(
      SUCCEED_SCRIPT,
      input,
      'succeed',
      permit.state,
      permit.generation,
      normalizePositive(input.halfOpenSuccessThreshold),
    );
  }

  async fail(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    if (permit.fallback) {
      await this.fallback.fail(input, permit);
      return;
    }
    await this.report(
      FAIL_SCRIPT,
      input,
      'fail',
      permit.state,
      permit.generation,
      normalizePositive(input.failureThreshold),
      Math.max(0, Math.floor(input.resetMs)),
    );
  }

  async release(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    if (permit.fallback) {
      await this.fallback.release(input, permit);
      return;
    }
    await this.report(RELEASE_SCRIPT, input, 'release', permit.state, permit.generation);
  }

  async checkConnection(): Promise<void> {
    const result = await this.client.ping();
    if (result !== 'PONG') throw new Error(`Redis circuit breaker ping returned ${result}`);
  }

  async close(): Promise<void> {
    if (!this.ownsClient) return;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect?.();
    }
  }

  private async report(
    script: string,
    input: ModelCircuitBreakerInput,
    fallbackOutcome: 'succeed' | 'fail' | 'release',
    ...args: Array<string | number>
  ): Promise<void> {
    try {
      await this.client.eval(script, 1, this.key(input), ...args);
    } catch (error) {
      this.options.onError?.(error);
      if (this.options.failOpen) await this.reportToFallback(input, fallbackOutcome);
    }
  }

  private async reportToFallback(
    input: ModelCircuitBreakerInput,
    outcome: 'succeed' | 'fail' | 'release',
  ): Promise<void> {
    const decision = await this.fallback.acquire(input);
    if (!decision.allowed) return;
    await this.fallback[outcome](input, decision.permit);
  }

  private key(input: ModelCircuitBreakerInput): string {
    return `${this.namespace}:{model-circuit}:${input.operation}:${encodeURIComponent(input.model)}`;
  }
}

function normalizePositive(value: number): number {
  return Math.max(1, Math.floor(value));
}
