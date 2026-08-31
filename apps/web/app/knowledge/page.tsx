import type { ReactElement } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { KnowledgeOrganizer } from '@/components/knowledge-organizer';

export default function KnowledgePage(): ReactElement {
  return (
    <main className="shell">
      <AppSidebar active="knowledge" />
      <section className="content knowledge-content">
        <KnowledgeOrganizer />
      </section>
    </main>
  );
}
