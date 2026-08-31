import { ShieldCheck } from 'lucide-react';
import type { ReactElement } from 'react';
import { AccessManagement } from '@/components/access-management';
import { AppSidebar } from '@/components/app-sidebar';

export default function AccessAdministrationPage(): ReactElement {
  return (
    <main className="shell">
      <AppSidebar active="settings" />
      <section className="content access-content">
        <header className="topbar">
          <div>
            <span className="eyebrow">组织与权限</span>
            <h1>访问控制</h1>
          </div>
          <ShieldCheck aria-hidden="true" className="access-title-icon" size={28} />
        </header>
        <AccessManagement />
      </section>
    </main>
  );
}
