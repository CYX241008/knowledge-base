import { describe, expect, it, vi } from 'vitest';
import { RedisModelRateLimiter, type RedisRateLimitClient } from './redis-rate-limiter.js';

describe('RedisModelRateLimiter', () => {
  it('uses one atomic script result to enforce a shared limit', async () => {
    const evalMock = vi
      .fn<RedisRateLimitClient['eval']>()
      .mockResolvedValueOnce([1, 60_000])
      .mockResolvedValueOnce([3, 42_000]);
    const limiter = new RedisModelRateLimiter({
      url: 'redis://localhost:6379',
      namespace: 'test namespace',
      client: fakeClient(evalMock),
    });
    const input = { operation: 'chat' as const, model: 'answer/model', limit: 2 };

    await expect(limiter.consume(input)).resolves.toEqual({ allowed: true });
    await expect(limiter.consume(input)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 42_000,
    });
    expect(evalMock.mock.calls[0]?.slice(1)).toEqual([
      1,
      'test_namespace:{model-quota}:chat:answer%2Fmodel',
      60_000,
    ]);
  });

  it('can fail open when Redis is unavailable', async () => {
    const onError = vi.fn();
    const limiter = new RedisModelRateLimiter({
      url: 'redis://localhost:6379',
      failOpen: true,
      onError,
      client: fakeClient(
        vi.fn<RedisRateLimitClient['eval']>().mockRejectedValue(new Error('down')),
      ),
    });

    await expect(
      limiter.consume({ operation: 'embedding', model: 'embedding-model', limit: 10 }),
    ).resolves.toEqual({ allowed: true });
    expect(onError).toHaveBeenCalledOnce();
  });
});

function fakeClient(evalMock: RedisRateLimitClient['eval']): RedisRateLimitClient {
  return {
    eval: evalMock,
    ping: vi.fn().mockResolvedValue('PONG'),
    quit: vi.fn().mockResolvedValue('OK'),
  };
}
