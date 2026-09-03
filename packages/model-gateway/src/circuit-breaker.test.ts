import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModelCircuitBreaker, type ModelCircuitBreakerInput } from './circuit-breaker.js';

const input: ModelCircuitBreakerInput = {
  operation: 'embedding',
  model: 'embedding-model',
  failureThreshold: 1,
  resetMs: 1_000,
  halfOpenMaxRequests: 1,
  halfOpenSuccessThreshold: 2,
  halfOpenProbeTimeoutMs: 90_000,
};

describe('LocalModelCircuitBreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits one half-open probe and closes only after the success threshold', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const breaker = new LocalModelCircuitBreaker();

    const initial = await breaker.acquire(input);
    expect(initial.allowed).toBe(true);
    if (!initial.allowed) throw new Error('Expected initial circuit permit');
    await breaker.fail(input, initial.permit);

    await expect(breaker.acquire(input)).resolves.toMatchObject({
      allowed: false,
      state: 'open',
      retryAfterMs: 1_000,
    });

    vi.advanceTimersByTime(1_000);
    const firstProbe = await breaker.acquire(input);
    expect(firstProbe.allowed).toBe(true);
    if (!firstProbe.allowed) throw new Error('Expected first half-open probe');
    expect(firstProbe.permit.state).toBe('half-open');
    await expect(breaker.acquire(input)).resolves.toEqual({
      allowed: false,
      state: 'half-open',
    });

    await breaker.succeed(input, firstProbe.permit);
    const secondProbe = await breaker.acquire(input);
    expect(secondProbe.allowed).toBe(true);
    if (!secondProbe.allowed) throw new Error('Expected second half-open probe');
    expect(secondProbe.permit.state).toBe('half-open');
    await breaker.succeed(input, secondProbe.permit);

    await expect(breaker.acquire(input)).resolves.toMatchObject({
      allowed: true,
      permit: { state: 'closed' },
    });
  });

  it('reopens immediately when a half-open probe fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const breaker = new LocalModelCircuitBreaker();
    const initial = await breaker.acquire(input);
    if (!initial.allowed) throw new Error('Expected initial circuit permit');
    await breaker.fail(input, initial.permit);

    vi.advanceTimersByTime(1_000);
    const probe = await breaker.acquire(input);
    if (!probe.allowed) throw new Error('Expected half-open probe');
    await breaker.fail(input, probe.permit);

    await expect(breaker.acquire(input)).resolves.toMatchObject({
      allowed: false,
      state: 'open',
      retryAfterMs: 1_000,
    });
  });

  it('reclaims a half-open permit after its probe lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    const breaker = new LocalModelCircuitBreaker();
    const initial = await breaker.acquire(input);
    if (!initial.allowed) throw new Error('Expected initial circuit permit');
    await breaker.fail(input, initial.permit);

    vi.advanceTimersByTime(1_000);
    const staleProbe = await breaker.acquire(input);
    if (!staleProbe.allowed) throw new Error('Expected initial half-open probe');
    vi.advanceTimersByTime(90_000);
    const replacementProbe = await breaker.acquire(input);
    if (!replacementProbe.allowed) throw new Error('Expected replacement half-open probe');
    expect(replacementProbe.permit.generation).not.toBe(staleProbe.permit.generation);

    await breaker.succeed(input, staleProbe.permit);
    await expect(breaker.acquire(input)).resolves.toEqual({
      allowed: false,
      state: 'half-open',
    });
  });
});
