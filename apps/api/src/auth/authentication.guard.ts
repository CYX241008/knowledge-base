import {
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { AuthContext, AuthenticatedRequest } from './auth-context';
import { PrincipalResolverService } from './principal-resolver.service';

export const AUTH_JWT_KEY_RESOLVER = Symbol('AUTH_JWT_KEY_RESOLVER');

@Injectable()
export class AuthenticationGuard implements CanActivate {
  private readonly mode: 'demo' | 'jwt';
  private readonly jwks: JWTVerifyGetKey | null;

  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Optional()
    @Inject(AUTH_JWT_KEY_RESOLVER)
    keyResolver?: JWTVerifyGetKey,
    @Optional()
    @Inject(PrincipalResolverService)
    private readonly principalResolver?: PrincipalResolverService,
  ) {
    this.mode = this.config.getOrThrow('AUTH_MODE');
    const jwksUrl = this.config.get('AUTH_JWT_JWKS_URL');
    this.jwks =
      keyResolver ??
      (this.mode === 'jwt' && jwksUrl
        ? createRemoteJWKSet(new URL(jwksUrl), {
            timeoutDuration: this.config.getOrThrow('AUTH_JWT_JWKS_TIMEOUT_MS'),
            cooldownDuration: this.config.getOrThrow('AUTH_JWT_JWKS_COOLDOWN_MS'),
            cacheMaxAge: this.config.getOrThrow('AUTH_JWT_JWKS_CACHE_MAX_AGE_MS'),
          })
        : null);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const base = this.mode === 'demo' ? this.demoContext() : await this.verifyBearer(request);
    request.knowledgeBaseAuth = this.principalResolver
      ? await this.principalResolver.resolve(base)
      : base;
    return true;
  }

  private demoContext(): AuthContext {
    const tenantId = this.config.getOrThrow('AUTH_DEMO_TENANT_ID');
    const userId = this.config.getOrThrow('AUTH_DEMO_USER_ID');
    const configured = this.config
      .getOrThrow<string>('AUTH_DEMO_PRINCIPAL_IDS')
      .split(',')
      .map((principalId) => principalId.trim())
      .filter(Boolean);
    return {
      tenantId,
      userId,
      principalIds: [...new Set([`tenant:${tenantId}`, `user:${userId}`, ...configured])],
      mode: 'demo',
    };
  }

  private async verifyBearer(request: AuthenticatedRequest): Promise<AuthContext> {
    const authorization = headerValue(request.headers.authorization);
    if (!authorization?.startsWith('Bearer ') || !this.jwks) throw unauthorized();
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.jwks, {
        issuer: this.config.getOrThrow('AUTH_JWT_ISSUER'),
        audience: this.config.getOrThrow('AUTH_JWT_AUDIENCE'),
        algorithms: this.config
          .getOrThrow<string>('AUTH_JWT_ALGORITHMS')
          .split(',')
          .map((algorithm) => algorithm.trim()),
        clockTolerance: this.config.getOrThrow('AUTH_JWT_CLOCK_TOLERANCE_SECONDS'),
      });
      const userId = requiredUuid(payload.sub, 'sub');
      const tenantClaim = this.config.getOrThrow('AUTH_JWT_TENANT_CLAIM');
      const principalsClaim = this.config.getOrThrow('AUTH_JWT_PRINCIPALS_CLAIM');
      const tenantId = requiredUuid(payload[tenantClaim], tenantClaim);
      const principalIds = stringArray(payload[principalsClaim], principalsClaim);
      return {
        tenantId,
        userId,
        principalIds: [...new Set([`user:${userId}`, ...principalIds])],
        mode: 'jwt',
      };
    } catch {
      throw unauthorized();
    }
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requiredUuid(value: unknown, claim: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error(`JWT claim ${claim} must be a UUID`);
  }
  return value;
}

function stringArray(value: unknown, claim: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 100 ||
    value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > 128)
  ) {
    throw new Error(`JWT claim ${claim} must be a non-empty string array`);
  }
  return value as string[];
}

function unauthorized(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'UNAUTHORIZED',
    message: 'A valid bearer token is required',
  });
}
