import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthSessionProvider } from '@/components/auth-session-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Knowledge Base',
  description: 'Enterprise knowledge operations workspace',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AuthSessionProvider>{children}</AuthSessionProvider>
      </body>
    </html>
  );
}
