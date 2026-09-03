import type { ModelOperation } from './index.js';

export type ModelCircuitState = 'closed' | 'open' | 'half-open';

export type ModelCircuitBreakerInput = {
  operation: ModelOperation;
  model: string;
  failureThreshold: number;
  resetMs: number;
  halfOpenMaxRequests: number;
  halfOpenSuccessThreshold: number;
  halfOpenProbeTimeoutMs: number;
};

export type ModelCircuitPermit = {
  state: 'closed' | 'half-open';
  generation: number;
  fallback?: true;
};

export type ModelCircuitDecision =
  | { allowed: true; permit: ModelCircuitPermit }
  | { allowed: false; state: 'open' | 'half-open'; retryAfterMs?: number };

export interface ModelCircuitBreaker {
  acquire(input: ModelCircuitBreakerInput): Promise<ModelCircuitDecision>;
  succeed(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void>;
  fail(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void>;
  release(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void>;
}

type CircuitRecord = {
  state: ModelCircuitState;
  failureCount: number;
  openUntil: number;
  generation: number;
  halfOpenInFlight: number;
  halfOpenSuccessCount: number;
  halfOpenLeaseUntil: number;
};

export class LocalModelCircuitBreaker implements ModelCircuitBreaker {
  private readonly records = new Map<string, CircuitRecord>();

  async acquire(input: ModelCircuitBreakerInput): Promise<ModelCircuitDecision> {
    const record = this.record(input);
    const now = Date.now();
    if (record.state === 'open') {
      if (now < record.openUntil) {
        return { allowed: false, state: 'open', retryAfterMs: record.openUntil - now };
      }
      record.state = 'half-open';
      record.halfOpenInFlight = 0;
      record.halfOpenSuccessCount = 0;
      record.halfOpenLeaseUntil = 0;
    }
    if (record.state === 'half-open') {
      if (record.halfOpenInFlight >= normalizePositive(input.halfOpenMaxRequests)) {
        if (now < record.halfOpenLeaseUntil) {
          return { allowed: false, state: 'half-open' };
        }
        record.halfOpenInFlight = 0;
        record.halfOpenSuccessCount = 0;
        record.halfOpenLeaseUntil = 0;
        record.generation += 1;
      }
      record.halfOpenInFlight += 1;
      record.halfOpenLeaseUntil = now + normalizePositive(input.halfOpenProbeTimeoutMs);
      return {
        allowed: true,
        permit: { state: 'half-open', generation: record.generation },
      };
    }
    return { allowed: true, permit: { state: 'closed', generation: record.generation } };
  }

  async succeed(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    const record = this.record(input);
    if (record.generation !== permit.generation) return;
    if (permit.state === 'closed') {
      if (record.state === 'closed') record.failureCount = 0;
      return;
    }
    if (record.state !== 'half-open') return;
    record.halfOpenInFlight = Math.max(0, record.halfOpenInFlight - 1);
    record.halfOpenSuccessCount += 1;
    if (record.halfOpenSuccessCount >= normalizePositive(input.halfOpenSuccessThreshold)) {
      record.state = 'closed';
      record.failureCount = 0;
      record.openUntil = 0;
      record.halfOpenInFlight = 0;
      record.halfOpenSuccessCount = 0;
      record.halfOpenLeaseUntil = 0;
      record.generation += 1;
    } else if (record.halfOpenInFlight === 0) {
      record.halfOpenLeaseUntil = 0;
    }
  }

  async fail(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    const record = this.record(input);
    if (record.generation !== permit.generation) return;
    if (permit.state === 'half-open') {
      if (record.state === 'half-open') this.open(record, input);
      return;
    }
    if (record.state !== 'closed') return;
    record.failureCount += 1;
    if (record.failureCount >= normalizePositive(input.failureThreshold)) {
      this.open(record, input);
    }
  }

  async release(input: ModelCircuitBreakerInput, permit: ModelCircuitPermit): Promise<void> {
    if (permit.state !== 'half-open') return;
    const record = this.record(input);
    if (record.state !== 'half-open' || record.generation !== permit.generation) return;
    record.halfOpenInFlight = Math.max(0, record.halfOpenInFlight - 1);
    if (record.halfOpenInFlight === 0) record.halfOpenLeaseUntil = 0;
  }

  private record(input: ModelCircuitBreakerInput): CircuitRecord {
    const key = `${input.operation}\0${input.model}`;
    let record = this.records.get(key);
    if (!record) {
      record = {
        state: 'closed',
        failureCount: 0,
        openUntil: 0,
        generation: 0,
        halfOpenInFlight: 0,
        halfOpenSuccessCount: 0,
        halfOpenLeaseUntil: 0,
      };
      this.records.set(key, record);
    }
    return record;
  }

  private open(record: CircuitRecord, input: ModelCircuitBreakerInput): void {
    record.state = 'open';
    record.failureCount = 0;
    record.openUntil = Date.now() + Math.max(0, input.resetMs);
    record.halfOpenInFlight = 0;
    record.halfOpenSuccessCount = 0;
    record.halfOpenLeaseUntil = 0;
    record.generation += 1;
  }
}

function normalizePositive(value: number): number {
  return Math.max(1, Math.floor(value));
}
