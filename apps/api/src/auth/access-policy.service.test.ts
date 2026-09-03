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
  permissionKeys: [],
  mode: 'demo',
};

describe('AccessPolicyService', () => {
  const policy = new AccessPolicyService();

  it('defaults document access to the authenticated user', () => {
    expect(policy.documentPrincipals(auth)).toEqual(['user:22222222-2222-4222-8222-222222222222']);
  });

  it('preserves requested principals for tenant validation in the access-control service', () => {
    expect(policy.documentPrincipals(auth, ['role:33333333-3333-4333-8333-333333333333'])).toEqual([
      'role:33333333-3333-4333-8333-333333333333',
    ]);
  });
});
