import type { TenantAccessPermissionKey } from '@knowledge-base/contracts';

export type AuthContext = {
  tenantId: string;
  userId: string;
  principalIds: string[];
  permissionKeys: TenantAccessPermissionKey[];
  mode: 'demo' | 'jwt';
};

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  knowledgeBaseAuth?: AuthContext;
};
