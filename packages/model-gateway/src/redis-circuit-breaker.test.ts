import { describe, expect, it, vi } from 'vitest';
import {
  RedisModelCircuitBreaker,
  type RedisCircuitBreakerClient,
} from './redis-circuit-breaker.js';
import type { ModelCircuitBreakerInput } from './circuit-breaker.js';

const input: ModelCircuitBreakerInput = {
  operation: 'chat',
  model: 'answer/model',
  failureThreshold: 5,
  resetMs: 30_000,
  halfOpenMaxRequests: 1,
  halfOpenSuccessThreshold: 2,
  halfOpenProbeTimeoutMs: 90_000,
};

describe('RedisModelCircuitBreaker', () => {
  it('uses the shared Redis decision to admit one half-open probe', async () => {
    const evalMock = vi
      .fn<RedisCircuitBreakerClient['eval']>()
      .mockResolvedValueOnce([1, 2, 7, 0])
      .mockResolvedValueOnce([0, 2, 7, 0])
      .mockResolvedValueOnce(1);
    const breaker = new RedisModelCircuitBreaker({
      url: 'redis://localhost:6379',
      namespace: 'test namespace',
      client: fakeClient(evalMock),
    });

    const first = await breaker.acquire(input);
    expect(first).toEqual({
      allowed: true,
      permit: { state: 'half-open', generation: 7 },
    });
    await expect(breaker.acquire(input)).resolves.toEqual({
      allowed: false,
      state: 'half-open',
    });
    if (!first.allowed) throw new Error('Expected Redis circuit permit');
    await breaker.succeed(input, first.permit);

    expect(evalMock.mock.calls[0]?.slice(1)).toEqual([
      1,
      'test_namespace:{model-circuit}:chat:answer%2Fmodel',
      1,
      90_000,
    ]);
    expect(evalMock.mock.calls[2]?.slice(1)).toEqual([
      1,
      'test_namespace:{model-circuit}:chat:answer%2Fmodel',
      'half-open',
      7,
      2,
    ]);
  });

  it('fails closed on Redis acquisition errors by default', async () => {
    const error = new Error('down');
    const onError = vi.fn();
    const breaker = new RedisModelCircuitBreaker({
      url: 'redis://localhost:6379',
      client: fakeClient(vi.fn<RedisCircuitBreakerClient['eval']>().mockRejectedValue(error)),
      onError,
    });

    await expect(breaker.acquire(input)).rejects.toThrow('down');
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('can fall back to a process-local breaker when configured fail-open', async () => {
    const breaker = new RedisModelCircuitBreaker({
      url: 'redis://localhost:6379',
      failOpen: true,
      client: fakeClient(
        vi.fn<RedisCircuitBreakerClient['eval']>().mockRejectedValue(new Error('down')),
      ),
    });

    await expect(breaker.acquire(input)).resolves.toMatchObject({
      allowed: true,
      permit: { state: 'closed', fallback: true },
    });
  });
});

function fakeClient(evalMock: RedisCircuitBreakerClient['eval']): RedisCircuitBreakerClient {
  return {
    eval: evalMock,
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}
