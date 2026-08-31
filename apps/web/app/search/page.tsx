import { Suspense, type ReactElement } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { SearchWorkspace, SearchWorkspaceFallback } from '@/components/search-workspace';

export default function SearchPage(): ReactElement {
  return (
    <main className="shell">
      <AppSidebar active="search" />
      <section className="content search-content">
        <Suspense fallback={<SearchWorkspaceFallback />}>
          <SearchWorkspace />
        </Suspense>
      </section>
    </main>
  );
}
