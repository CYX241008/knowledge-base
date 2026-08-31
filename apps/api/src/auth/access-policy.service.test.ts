import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from './auth-context';
import { AccessPolicyService } from './access-policy.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: [
    'tenant:11111111-1111-4111-8111-111111111111',
    'user:22222222-2222-4222-8222-222222222222',
  ],
  mode: 'demo',
};

describe('AccessPolicyService', () => {
  const policy = new AccessPolicyService();

  it('defaults document access to the authenticated tenant', () => {
    expect(policy.documentPrincipals(auth)).toEqual([
      'tenant:11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('rejects principals outside the authenticated identity', () => {
    expect(() => policy.documentPrincipals(auth, ['role:admin'])).toThrow(ForbiddenException);
  });
});
