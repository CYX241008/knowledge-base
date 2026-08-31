import { describe, expect, it } from 'vitest';
import {
  canTransitionIngestionStatus,
  parseAccessPrincipalId,
  principalsOverlap,
  uniqueAccessPrincipalIds,
} from './index';

describe('ingestion state transitions', () => {
  it('allows the normal processing path', () => {
    expect(canTransitionIngestionStatus('parsing', 'normalizing')).toBe(true);
    expect(canTransitionIngestionStatus('normalizing', 'chunking')).toBe(true);
  });
  it('does not allow a ready document to re-enter indexing', () =>
    expect(canTransitionIngestionStatus('ready', 'indexing')).toBe(false));
  it('only allows a failed job to enter retrying', () => {
    expect(canTransitionIngestionStatus('failed', 'retrying')).toBe(true);
    expect(canTransitionIngestionStatus('failed', 'received')).toBe(false);
  });
  it('treats cancellation as terminal', () => {
    expect(canTransitionIngestionStatus('parsing', 'cancelled')).toBe(true);
    expect(canTransitionIngestionStatus('cancelled', 'retrying')).toBe(false);
    expect(canTransitionIngestionStatus('cancelled', 'ready')).toBe(false);
  });
});

describe('access principals', () => {
  const userPrincipal = 'user:11111111-1111-4111-8111-111111111111';

  it('parses supported typed UUID principals', () => {
    expect(parseAccessPrincipalId(userPrincipal)).toEqual({
      type: 'user',
      id: '11111111-1111-4111-8111-111111111111',
    });
    expect(parseAccessPrincipalId('permission:documents.read')).toBeNull();
  });

  it('normalizes duplicates and rejects forged principals', () => {
    expect(uniqueAccessPrincipalIds([userPrincipal, userPrincipal])).toEqual([userPrincipal]);
    expect(() => uniqueAccessPrincipalIds(['role:reader'])).toThrow();
  });

  it('detects effective-principal overlap', () => {
    expect(principalsOverlap([userPrincipal], [userPrincipal])).toBe(true);
    expect(
      principalsOverlap([userPrincipal], ['tenant:22222222-2222-4222-8222-222222222222']),
    ).toBe(false);
  });
});
