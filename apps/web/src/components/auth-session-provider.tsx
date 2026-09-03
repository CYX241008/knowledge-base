'use client';

import type { AuthSessionResponse, TenantAccessPermissionKey } from '@knowledge-base/contracts';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

type AuthSessionState = {
  session: AuthSessionResponse | null;
  loading: boolean;
  hasPermission: (permission: TenantAccessPermissionKey) => boolean;
};

const AuthSessionContext = createContext<AuthSessionState>({
  session: null,
  loading: true,
  hasPermission: () => false,
});

export function AuthSessionProvider({ children }: { children: ReactNode }): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const [session, setSession] = useState<AuthSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch(`${apiBase}/auth/me`)
      .then(async (response) => {
        const body = (await response.json()) as { ok?: boolean; data?: AuthSessionResponse };
        if (!response.ok || !body.ok || !body.data) throw new Error('Authentication failed');
        if (active) setSession(body.data);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiBase]);

  const value = useMemo<AuthSessionState>(
    () => ({
      session,
      loading,
      hasPermission: (permission) =>
        Boolean(
          session?.permissionKeys.includes('access.manage') ||
          session?.permissionKeys.includes(permission),
        ),
    }),
    [loading, session],
  );

  return <AuthSessionContext.Provider value={value}>{children}</AuthSessionContext.Provider>;
}

export function useAuthSession(): AuthSessionState {
  return useContext(AuthSessionContext);
}
