import {
  BookOpen,
  FileSearch,
  FileText,
  FolderTree,
  MessageSquareText,
  Settings2,
  Sparkles,
} from 'lucide-react';
import type { ReactElement } from 'react';
import { ApiStatus } from '@/components/api-status';

type NavigationItem = 'workspace' | 'knowledge' | 'search' | 'settings';

export function AppSidebar({ active }: { active: NavigationItem }): ReactElement {
  return (
    <aside className="sidebar">
      <a className="brand" href="/">
        <BookOpen size={20} /> 知识库
      </a>
      <nav>
        <a className={active === 'workspace' ? 'active' : undefined} href="/#workspace">
          <Sparkles size={17} /> 工作台
        </a>
        <a href="/#documents">
          <FileText size={17} /> 文档管理
        </a>
        <a className={active === 'knowledge' ? 'active' : undefined} href="/knowledge">
          <FolderTree size={17} /> 知识组织
        </a>
        <a className={active === 'search' ? 'active' : undefined} href="/search">
          <FileSearch size={17} /> 全文搜索
        </a>
        <a href="/#assistant">
          <MessageSquareText size={17} /> 知识问答
        </a>
        <a className={active === 'settings' ? 'active' : undefined} href="/admin/settings">
          <Settings2 size={17} /> 系统设置
        </a>
      </nav>
      <div className="sidebar-footer">
        <ApiStatus />
      </div>
    </aside>
  );
}
