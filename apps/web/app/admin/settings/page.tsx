import { Suspense, type ReactElement } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import {
  SystemSettingsWorkspace,
  SystemSettingsWorkspaceFallback,
} from '@/components/system-settings-workspace';

export default function SystemSettingsPage(): ReactElement {
  return (
    <main className="shell">
      <AppSidebar active="settings" />
      <section className="content settings-content">
        <Suspense fallback={<SystemSettingsWorkspaceFallback />}>
          <SystemSettingsWorkspace />
        </Suspense>
      </section>
    </main>
  );
}
