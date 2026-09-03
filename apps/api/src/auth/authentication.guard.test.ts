import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { ServerEnv } from '@knowledge-base/config';
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AuthenticatedRequest } from './auth-context';
import { AuthenticationGuard } from './authentication.guard';

const issuer = 'https://identity.example';
const audience = 'knowledge-base';
const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const roleId = '33333333-3333-4333-8333-333333333333';
const keys = new Map<string, CryptoKey>();
let firstPrivateKey: CryptoKey;
let secondPrivateKey: CryptoKey;
let secondPublicKey: CryptoKey;

beforeAll(async () => {
  const first = await generateKeyPair('RS256');
  const second = await generateKeyPair('RS256');
  firstPrivateKey = first.privateKey;
  secondPrivateKey = second.privateKey;
  secondPublicKey = second.publicKey;
  keys.set('key-1', first.publicKey);
});

describe('AuthenticationGuard JWT mode', () => {
  const resolver: JWTVerifyGetKey = async (protectedHeader) => {
    const key = protectedHeader.kid ? keys.get(protectedHeader.kid) : undefined;
    if (!key) throw new Error('Unknown signing key');
    return key;
  };
  const guard = new AuthenticationGuard(configService(), resolver);

  it('builds trusted identity and supports signing-key rotation', async () => {
    const firstRequest = requestWithToken(await signToken(firstPrivateKey, 'key-1'));
    await expect(guard.canActivate(contextFor(firstRequest))).resolves.toBe(true);
    expect(firstRequest.knowledgeBaseAuth).toEqual({
      tenantId,
      userId,
      principalIds: [`tenant:${tenantId}`, `user:${userId}`, `role:${roleId}`],
      permissionKeys: [],
      mode: 'jwt',
    });

    keys.set('key-2', secondPublicKey);
    await expect(
      guard.canActivate(contextFor(requestWithToken(await signToken(secondPrivateKey, 'key-2')))),
    ).resolves.toBe(true);
  });

  it.each([
    ['expired token', { expirationTime: Math.floor(Date.now() / 1000) - 30 }],
    ['wrong issuer', { issuer: 'https://attacker.example' }],
    ['wrong audience', { audience: 'another-service' }],
    ['invalid tenant claim', { tenantId: 'not-a-uuid' }],
    ['invalid principal claim', { principalIds: [] }],
    [
      'cross-tenant principal claim',
      { principalIds: ['tenant:55555555-5555-4555-8555-555555555555'] },
    ],
  ])('rejects %s', async (_label, overrides) => {
    const token = await signToken(firstPrivateKey, 'key-1', overrides);
    await expect(guard.canActivate(contextFor(requestWithToken(token)))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects requests without a bearer token', async () => {
    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('separates tenant permission claims from ACL principals', async () => {
    const request = requestWithToken(
      await signToken(firstPrivateKey, 'key-1', {
        principalIds: [`tenant:${tenantId}`, `role:${roleId}`, 'permission:knowledge.manage'],
      }),
    );
    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.knowledgeBaseAuth?.principalIds).toEqual([
      `tenant:${tenantId}`,
      `user:${userId}`,
      `role:${roleId}`,
    ]);
    expect(request.knowledgeBaseAuth?.permissionKeys).toEqual(['knowledge.manage']);
  });
});

function configService(): ConfigService<ServerEnv, true> {
  const values = {
    AUTH_MODE: 'jwt',
    AUTH_JWT_JWKS_URL: 'https://identity.example/.well-known/jwks.json',
    AUTH_JWT_ISSUER: issuer,
    AUTH_JWT_AUDIENCE: audience,
    AUTH_JWT_ALGORITHMS: 'RS256',
    AUTH_JWT_CLOCK_TOLERANCE_SECONDS: 0,
    AUTH_JWT_JWKS_TIMEOUT_MS: 5_000,
    AUTH_JWT_JWKS_COOLDOWN_MS: 0,
    AUTH_JWT_JWKS_CACHE_MAX_AGE_MS: 600_000,
    AUTH_JWT_TENANT_CLAIM: 'tenant_id',
    AUTH_JWT_PRINCIPALS_CLAIM: 'principal_ids',
  } satisfies Partial<ServerEnv>;
  return {
    get: (key: keyof ServerEnv) => values[key as keyof typeof values],
    getOrThrow: (key: keyof ServerEnv) => {
      const value = values[key as keyof typeof values];
      if (value === undefined) throw new Error(`Missing ${key}`);
      return value;
    },
  } as ConfigService<ServerEnv, true>;
}

function requestWithToken(token: string): AuthenticatedRequest {
  return { headers: { authorization: `Bearer ${token}` } };
}

function contextFor(request: AuthenticatedRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

async function signToken(
  privateKey: CryptoKey,
  kid: string,
  overrides: {
    issuer?: string;
    audience?: string;
    expirationTime?: number;
    tenantId?: string;
    principalIds?: string[];
  } = {},
): Promise<string> {
  return new SignJWT({
    tenant_id: overrides.tenantId ?? tenantId,
    principal_ids: overrides.principalIds ?? [`tenant:${tenantId}`, `role:${roleId}`],
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject(userId)
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setIssuedAt()
    .setExpirationTime(overrides.expirationTime ?? '5m')
    .sign(privateKey);
}
