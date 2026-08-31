import type { ReactElement } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { DocumentWorkspace } from '@/components/document-workspace';

export default function HomePage(): ReactElement {
  return (
    <main className="shell">
      <AppSidebar active="workspace" />
      <DocumentWorkspace />
    </main>
  );
}
