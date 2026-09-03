import { describe, expect, it, vi } from 'vitest';
import { RedisModelRateLimiter, type RedisRateLimitClient } from './redis-rate-limiter.js';

describe('RedisModelRateLimiter', () => {
  it('uses one atomic script result to enforce a shared limit', async () => {
    const evalMock = vi
      .fn<RedisRateLimitClient['eval']>()
      .mockResolvedValueOnce([1, 60_000])
      .mockResolvedValueOnce([0, 42_000]);
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
      1,
      2,
    ]);
  });

  it('reserves global, tenant, user, and model tokens then settles the difference', async () => {
    const evalMock = vi
      .fn<RedisRateLimitClient['eval']>()
      .mockResolvedValueOnce([1, 60_000])
      .mockResolvedValueOnce(4);
    const limiter = new RedisModelRateLimiter({
      url: 'redis://localhost:6379',
      namespace: 'quota',
      client: fakeClient(evalMock),
    });

    const decision = await limiter.consume({
      operation: 'chat',
      model: 'answer-model',
      limit: 100,
      estimatedTokens: 1_500,
      tokenLimits: {
        global: 100_000,
        tenant: 20_000,
        user: 5_000,
        model: { chat: 50_000 },
      },
      context: {
        tenantId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(decision).toMatchObject({
      allowed: true,
      reservation: { reservedTokens: 1_500 },
    });
    expect(evalMock.mock.calls[0]?.slice(1, 7)).toEqual([
      5,
      'quota:{model-quota}:chat:answer-model',
      'quota:{model-quota}:tpm:global',
      'quota:{model-quota}:tpm:tenant:11111111-1111-4111-8111-111111111111',
      'quota:{model-quota}:tpm:user:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      'quota:{model-quota}:tpm:model:chat:answer-model',
    ]);

    if (!decision.reservation) throw new Error('Expected a token reservation');
    await limiter.settle(decision.reservation, 1_000);
    expect(evalMock.mock.calls[1]?.slice(1)).toEqual([
      4,
      'quota:{model-quota}:tpm:global',
      'quota:{model-quota}:tpm:tenant:11111111-1111-4111-8111-111111111111',
      'quota:{model-quota}:tpm:user:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      'quota:{model-quota}:tpm:model:chat:answer-model',
      -500,
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
