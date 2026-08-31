import { describe, expect, it } from 'vitest';
import { outboxBackoffMs } from './outbox-dispatcher.service';

describe('outbox backoff', () => {
  it('uses exponential delays capped at one minute', () => {
    expect(outboxBackoffMs(1)).toBe(1_000);
    expect(outboxBackoffMs(2)).toBe(2_000);
    expect(outboxBackoffMs(7)).toBe(60_000);
    expect(outboxBackoffMs(20)).toBe(60_000);
  });
});
