import { ForbiddenException, Injectable } from '@nestjs/common';
import type { AuthContext } from './auth-context';

@Injectable()
export class AccessPolicyService {
  documentPrincipals(auth: AuthContext, requested?: string[]): string[] {
    const allowed = new Set(auth.principalIds);
    if (requested && requested.length > 0) {
      const unique = [...new Set(requested)];
      if (unique.some((principalId) => !allowed.has(principalId))) {
        throw new ForbiddenException({
          code: 'INVALID_DOCUMENT_PRINCIPAL',
          message: 'Document access can only be granted to an effective principal',
        });
      }
      return unique;
    }
    const tenantPrincipal = `tenant:${auth.tenantId}`;
    return allowed.has(tenantPrincipal) ? [tenantPrincipal] : [`user:${auth.userId}`];
  }
}
