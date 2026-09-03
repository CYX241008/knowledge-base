import { Injectable } from '@nestjs/common';
import type { AuthContext } from './auth-context';

@Injectable()
export class AccessPolicyService {
  documentPrincipals(auth: AuthContext, requested?: string[]): string[] {
    if (requested && requested.length > 0) {
      return [...new Set(requested)];
    }
    return [`user:${auth.userId}`];
  }
}
