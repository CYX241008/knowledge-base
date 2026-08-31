export type AuthContext = {
  tenantId: string;
  userId: string;
  principalIds: string[];
  mode: 'demo' | 'jwt';
};

export type AuthenticatedRequest = {
  headers: Record<string, string | string[] | undefined>;
  knowledgeBaseAuth?: AuthContext;
};
