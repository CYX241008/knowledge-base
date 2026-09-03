'use client';

import type {
  AccessPrincipalDirectoryResponse,
  KnowledgeFolder,
  KnowledgeOverviewResponse,
  KnowledgeSpace,
  KnowledgeTag,
  OrganizedDocument,
} from '@knowledge-base/contracts';
import { Button } from '@knowledge-base/ui/button';
import {
  Check,
  ChevronRight,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Tag,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useAuthSession } from '@/components/auth-session-provider';

type View = 'library' | 'tags';
type ContainerSelection = { type: 'space' | 'folder'; id: string };
type PrincipalChoice = { id: string; label: string; type: string };

export function KnowledgeOrganizer(): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const auth = useAuthSession();
  const canManageKnowledge = auth.hasPermission('knowledge.manage');
  const [overview, setOverview] = useState<KnowledgeOverviewResponse | null>(null);
  const [directory, setDirectory] = useState<AccessPrincipalDirectoryResponse | null>(null);
  const [view, setView] = useState<View>('library');
  const [selection, setSelection] = useState<ContainerSelection | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);

  const load = useCallback(async () => {
    if (auth.loading) return;
    setLoading(true);
    setError(null);
    try {
      const [knowledgeData, principalDirectory] = await Promise.all([
        requestApi<KnowledgeOverviewResponse>(`${apiBase}/knowledge/overview`),
        canManageKnowledge
          ? requestApi<AccessPrincipalDirectoryResponse>(`${apiBase}/access/principals`)
          : Promise.resolve(null),
      ]);
      setOverview(knowledgeData);
      setDirectory(principalDirectory);
      setSelection((current) => {
        if (
          current?.type === 'space' &&
          knowledgeData.spaces.some((space) => space.id === current.id)
        )
          return current;
        if (
          current?.type === 'folder' &&
          knowledgeData.folders.some((folder) => folder.id === current.id)
        )
          return current;
        const first = knowledgeData.spaces[0];
        return first ? { type: 'space', id: first.id } : null;
      });
      setSelectedDocumentId((current) =>
        current && knowledgeData.documents.some((document) => document.id === current)
          ? current
          : null,
      );
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [apiBase, auth.loading, canManageKnowledge]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        await load();
        setNotice(message);
      } catch (mutationError) {
        setError(messageOf(mutationError));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const principalChoices = useMemo(() => buildPrincipalChoices(directory), [directory]);
  const selectedSpace =
    selection?.type === 'space'
      ? (overview?.spaces.find((space) => space.id === selection.id) ?? null)
      : selection?.type === 'folder'
        ? (overview?.spaces.find(
            (space) =>
              space.id === overview.folders.find((folder) => folder.id === selection.id)?.spaceId,
          ) ?? null)
        : null;
  const selectedFolder =
    selection?.type === 'folder'
      ? (overview?.folders.find((folder) => folder.id === selection.id) ?? null)
      : null;
  const selectedDocument =
    overview?.documents.find((document) => document.id === selectedDocumentId) ?? null;
  const visibleDocuments = useMemo(
    () => filterDocuments(overview?.documents ?? [], selection),
    [overview?.documents, selection],
  );

  if ((loading || auth.loading) && !overview) {
    return (
      <div className="knowledge-loading" role="status">
        <LoaderCircle className="spinning" size={20} /> 正在载入知识组织数据
      </div>
    );
  }

  if (!overview || (canManageKnowledge && !directory)) {
    return (
      <div className="knowledge-loading failure" role="alert">
        <span>{error ?? '知识组织数据载入失败'}</span>
        <Button onClick={() => void load()} variant="secondary">
          <RefreshCw size={15} /> 重试
        </Button>
      </div>
    );
  }

  return (
    <>
      <header className="topbar knowledge-topbar">
        <div>
          <span className="eyebrow">知识资产</span>
          <h1>知识组织</h1>
        </div>
        <div className="knowledge-header-actions">
          <button
            aria-label="刷新知识组织数据"
            className="icon-button"
            disabled={loading || busy}
            onClick={() => void load()}
            title="刷新"
            type="button"
          >
            <RefreshCw className={loading ? 'spinning' : ''} size={16} />
          </button>
          {canManageKnowledge ? (
            <Button disabled={busy} onClick={() => setCreatingSpace(true)}>
              <Plus size={15} /> 新建空间
            </Button>
          ) : null}
        </div>
      </header>

      <div className="metrics knowledge-metrics">
        <div>
          <span>知识空间</span>
          <strong>{overview.spaces.length}</strong>
          <small>{overview.folders.length} 个文件夹</small>
        </div>
        <div>
          <span>已归档文档</span>
          <strong>{overview.documents.filter((document) => document.spaceId).length}</strong>
          <small>共 {overview.documents.length} 篇</small>
        </div>
        <div>
          <span>标签</span>
          <strong>{overview.tags.length}</strong>
          <small>{overview.tags.reduce((sum, tag) => sum + tag.documentCount, 0)} 次绑定</small>
        </div>
        <div>
          <span>当前租户</span>
          <strong className="metric-name">{directory?.tenant.name ?? '当前租户'}</strong>
          <small>
            {canManageKnowledge ? `${directory?.principals.length ?? 0} 个授权主体` : '只读视图'}
          </small>
        </div>
      </div>

      {error ? <div className="notice">{error}</div> : null}
      {notice ? <div className="access-success">{notice}</div> : null}

      <div className="knowledge-toolbar">
        <div className="access-tabs" role="tablist" aria-label="知识组织视图">
          <button
            aria-selected={view === 'library'}
            className={view === 'library' ? 'active' : ''}
            onClick={() => setView('library')}
            role="tab"
            type="button"
          >
            <FolderTree size={15} /> 空间与文件夹
          </button>
          <button
            aria-selected={view === 'tags'}
            className={view === 'tags' ? 'active' : ''}
            onClick={() => setView('tags')}
            role="tab"
            type="button"
          >
            <Tags size={15} /> 标签
          </button>
        </div>
      </div>

      {view === 'library' ? (
        <div className="knowledge-workspace">
          <LibraryTree
            busy={busy}
            canCreate={canManageKnowledge}
            folders={overview.folders}
            onCreateFolder={(name, parentId) => {
              if (!selectedSpace) return Promise.resolve();
              return mutate(
                () =>
                  requestApi(`${apiBase}/knowledge/folders`, {
                    method: 'POST',
                    headers: jsonHeaders,
                    body: JSON.stringify({ spaceId: selectedSpace.id, parentId, name }),
                  }),
                '文件夹已创建',
              );
            }}
            onSelect={(next) => {
              setSelection(next);
              setSelectedDocumentId(null);
            }}
            selection={selection}
            spaces={overview.spaces}
          />
          <DocumentList
            documents={visibleDocuments}
            folders={overview.folders}
            onSelect={setSelectedDocumentId}
            selectedDocumentId={selectedDocumentId}
            selectedSpace={selectedSpace}
          />
          {selectedDocument && selectedDocument.allowedPermissions.includes('documents.update') ? (
            <DocumentEditor
              busy={busy}
              document={selectedDocument}
              folders={overview.folders}
              onClose={() => setSelectedDocumentId(null)}
              onSave={(spaceId, folderId, tagIds) =>
                mutate(async () => {
                  await requestApi(
                    `${apiBase}/knowledge/documents/${selectedDocument.id}/location`,
                    {
                      method: 'PUT',
                      headers: jsonHeaders,
                      body: JSON.stringify({ spaceId, folderId }),
                    },
                  );
                  await requestApi(`${apiBase}/knowledge/documents/${selectedDocument.id}/tags`, {
                    method: 'PUT',
                    headers: jsonHeaders,
                    body: JSON.stringify({ tagIds }),
                  });
                }, '文档归档信息已更新')
              }
              spaces={overview.spaces}
              tags={overview.tags}
            />
          ) : selectedDocument ? (
            <ReadOnlyInspector title={selectedDocument.title} />
          ) : selectedSpace && canManageKnowledge ? (
            <ContainerEditor
              busy={busy}
              folder={selectedFolder}
              folders={overview.folders}
              onDelete={() => {
                const target = selectedFolder ?? selectedSpace;
                if (!window.confirm(`确认删除“${target.name}”？`)) return;
                const path = selectedFolder
                  ? `folders/${selectedFolder.id}`
                  : `spaces/${selectedSpace.id}`;
                void mutate(
                  () => requestApi(`${apiBase}/knowledge/${path}`, { method: 'DELETE' }),
                  selectedFolder ? '文件夹已删除' : '知识空间已删除',
                );
              }}
              onSave={(name, description, parentId, principalIds) => {
                const path = selectedFolder
                  ? `folders/${selectedFolder.id}`
                  : `spaces/${selectedSpace.id}`;
                return mutate(
                  async () => {
                    await requestApi(`${apiBase}/knowledge/${path}`, {
                      method: 'PATCH',
                      headers: jsonHeaders,
                      body: JSON.stringify(
                        selectedFolder ? { name, description, parentId } : { name, description },
                      ),
                    });
                    await requestApi(`${apiBase}/knowledge/${path}/acl`, {
                      method: 'PUT',
                      headers: jsonHeaders,
                      body: JSON.stringify({ principalIds }),
                    });
                  },
                  selectedFolder ? '文件夹设置已保存' : '知识空间设置已保存',
                );
              }}
              principalChoices={principalChoices}
              space={selectedSpace}
            />
          ) : selectedSpace ? (
            <ReadOnlyInspector title={selectedFolder?.name ?? selectedSpace.name} />
          ) : (
            <EmptyInspector />
          )}
        </div>
      ) : (
        <TagManager
          busy={busy}
          readOnly={!canManageKnowledge}
          onCreate={(name, color, description) =>
            mutate(
              () =>
                requestApi(`${apiBase}/knowledge/tags`, {
                  method: 'POST',
                  headers: jsonHeaders,
                  body: JSON.stringify({ name, color, description }),
                }),
              '标签已创建',
            )
          }
          onDelete={(tag) => {
            if (!window.confirm(`确认删除标签“${tag.name}”？`)) return Promise.resolve();
            return mutate(
              () => requestApi(`${apiBase}/knowledge/tags/${tag.id}`, { method: 'DELETE' }),
              '标签已删除',
            );
          }}
          onUpdate={(tagId, name, color, description) =>
            mutate(
              () =>
                requestApi(`${apiBase}/knowledge/tags/${tagId}`, {
                  method: 'PATCH',
                  headers: jsonHeaders,
                  body: JSON.stringify({ name, color, description }),
                }),
              '标签已更新',
            )
          }
          tags={overview.tags}
        />
      )}

      {creatingSpace && canManageKnowledge && directory ? (
        <SpaceDialog
          busy={busy}
          defaultPrincipalId={`tenant:${directory.tenant.id}`}
          onClose={() => setCreatingSpace(false)}
          onCreate={(name, description, principalIds) =>
            mutate(
              () =>
                requestApi(`${apiBase}/knowledge/spaces`, {
                  method: 'POST',
                  headers: jsonHeaders,
                  body: JSON.stringify({ name, description, principalIds }),
                }),
              '知识空间已创建',
            ).then(() => setCreatingSpace(false))
          }
          principalChoices={principalChoices}
        />
      ) : null}
    </>
  );
}

function LibraryTree({
  busy,
  canCreate,
  folders,
  onCreateFolder,
  onSelect,
  selection,
  spaces,
}: {
  busy: boolean;
  canCreate: boolean;
  folders: KnowledgeFolder[];
  onCreateFolder: (name: string, parentId: string | null) => Promise<void>;
  onSelect: (selection: ContainerSelection) => void;
  selection: ContainerSelection | null;
  spaces: KnowledgeSpace[];
}): ReactElement {
  const [folderName, setFolderName] = useState('');
  const activeSpaceId =
    selection?.type === 'space'
      ? selection.id
      : folders.find((folder) => folder.id === selection?.id)?.spaceId;
  const rows = flattenFolders(folders, activeSpaceId ?? null);
  const parentId = selection?.type === 'folder' ? selection.id : null;

  return (
    <aside className="knowledge-tree-pane">
      <div className="knowledge-pane-heading">
        <strong>知识空间</strong>
        <span>{spaces.length}</span>
      </div>
      <div className="space-list">
        {spaces.map((space) => (
          <button
            className={selection?.type === 'space' && selection.id === space.id ? 'active' : ''}
            key={space.id}
            onClick={() => onSelect({ type: 'space', id: space.id })}
            type="button"
          >
            <FolderOpen size={16} />
            <span>{space.name}</span>
            <ChevronRight size={14} />
          </button>
        ))}
        {spaces.length === 0 ? <div className="knowledge-empty">暂无知识空间</div> : null}
      </div>
      {activeSpaceId ? (
        <>
          <div className="knowledge-pane-heading folder-heading">
            <strong>文件夹</strong>
            <span>{rows.length}</span>
          </div>
          <div className="folder-tree-list">
            {rows.map(({ folder, depth }) => (
              <button
                className={
                  selection?.type === 'folder' && selection.id === folder.id ? 'active' : ''
                }
                key={folder.id}
                onClick={() => onSelect({ type: 'folder', id: folder.id })}
                style={{ paddingLeft: 12 + depth * 18 }}
                type="button"
              >
                <Folder size={15} /> <span>{folder.name}</span>
              </button>
            ))}
          </div>
          {canCreate ? (
            <form
              className="folder-create"
              onSubmit={(event) => {
                event.preventDefault();
                if (!folderName.trim()) return;
                void onCreateFolder(folderName.trim(), parentId).then(() => setFolderName(''));
              }}
            >
              <input
                aria-label="文件夹名称"
                disabled={busy}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder={parentId ? '新建子文件夹' : '新建文件夹'}
                value={folderName}
              />
              <button
                aria-label="创建文件夹"
                disabled={busy || !folderName.trim()}
                title="创建文件夹"
                type="submit"
              >
                <FolderPlus size={15} />
              </button>
            </form>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function DocumentList({
  documents,
  folders,
  onSelect,
  selectedDocumentId,
  selectedSpace,
}: {
  documents: OrganizedDocument[];
  folders: KnowledgeFolder[];
  onSelect: (id: string) => void;
  selectedDocumentId: string | null;
  selectedSpace: KnowledgeSpace | null;
}): ReactElement {
  return (
    <section className="knowledge-documents-pane">
      <div className="knowledge-pane-heading document-pane-heading">
        <div>
          <strong>{selectedSpace?.name ?? '未归档文档'}</strong>
          <span>{documents.length} 篇文档</span>
        </div>
        <FileText size={17} />
      </div>
      <div className="knowledge-document-head">
        <span>文档</span>
        <span>位置</span>
        <span>状态</span>
      </div>
      <div className="knowledge-document-list">
        {documents.map((document) => {
          const folder = folders.find((item) => item.id === document.folderId);
          return (
            <button
              className={selectedDocumentId === document.id ? 'active' : ''}
              key={document.id}
              onClick={() => onSelect(document.id)}
              type="button"
            >
              <span className="knowledge-document-title">
                <FileText size={15} /> <strong>{document.title}</strong>
              </span>
              <span>{folder?.name ?? (document.spaceId ? '空间根目录' : '未归档')}</span>
              <span className={`document-state ${document.status}`}>
                {statusLabel(document.status)}
              </span>
            </button>
          );
        })}
        {documents.length === 0 ? (
          <div className="knowledge-empty document-empty">暂无文档</div>
        ) : null}
      </div>
    </section>
  );
}

function ContainerEditor({
  busy,
  folder,
  folders,
  onDelete,
  onSave,
  principalChoices,
  space,
}: {
  busy: boolean;
  folder: KnowledgeFolder | null;
  folders: KnowledgeFolder[];
  onDelete: () => void;
  onSave: (
    name: string,
    description: string | null,
    parentId: string | null,
    principalIds: string[],
  ) => Promise<void>;
  principalChoices: PrincipalChoice[];
  space: KnowledgeSpace;
}): ReactElement {
  const target = folder ?? space;
  const [name, setName] = useState(target.name);
  const [description, setDescription] = useState(target.description ?? '');
  const [parentId, setParentId] = useState(folder?.parentId ?? '');
  const [principalIds, setPrincipalIds] = useState(
    folder ? folder.directPrincipalIds : space.principalIds,
  );

  useEffect(() => {
    setName(target.name);
    setDescription(target.description ?? '');
    setParentId(folder?.parentId ?? '');
    setPrincipalIds(folder ? folder.directPrincipalIds : space.principalIds);
  }, [folder, space, target.description, target.name]);

  const parentOptions = folders.filter(
    (candidate) => candidate.spaceId === space.id && candidate.id !== folder?.id,
  );

  return (
    <aside className="knowledge-inspector">
      <div className="knowledge-inspector-heading">
        <div>
          {folder ? <FolderInput size={18} /> : <FolderOpen size={18} />}
          <strong>{folder ? '文件夹设置' : '空间设置'}</strong>
        </div>
        <button
          aria-label={`删除${folder ? '文件夹' : '空间'}`}
          className="icon-button danger"
          disabled={busy}
          onClick={onDelete}
          title="删除"
          type="button"
        >
          <Trash2 size={15} />
        </button>
      </div>
      <EditorField label="名称">
        <input
          className="text-input"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </EditorField>
      <EditorField label="说明">
        <textarea
          className="knowledge-textarea"
          onChange={(event) => setDescription(event.target.value)}
          value={description}
        />
      </EditorField>
      {folder ? (
        <EditorField label="上级文件夹">
          <select
            className="access-select"
            onChange={(event) => setParentId(event.target.value)}
            value={parentId}
          >
            <option value="">空间根目录</option>
            {parentOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </EditorField>
      ) : null}
      <div className="inspector-divider" />
      <div className="inspector-section-title">
        <ShieldCheck size={16} /> <strong>访问主体</strong>
      </div>
      <div className="principal-list">
        {principalChoices.map((principal) => (
          <label key={principal.id}>
            <input
              checked={principalIds.includes(principal.id)}
              onChange={(event) =>
                setPrincipalIds(toggleValue(principalIds, principal.id, event.target.checked))
              }
              type="checkbox"
            />
            <span>
              <strong>{principal.label}</strong>
              <small>{principal.type}</small>
            </span>
          </label>
        ))}
      </div>
      {folder && principalIds.length === 0 ? (
        <p className="inherit-note">继承上级文件夹与空间权限</p>
      ) : null}
      <Button
        className="inspector-save"
        disabled={busy || !name.trim() || (!folder && principalIds.length === 0)}
        onClick={() =>
          void onSave(name.trim(), description.trim() || null, parentId || null, principalIds)
        }
      >
        <Save size={15} /> 保存设置
      </Button>
    </aside>
  );
}

function DocumentEditor({
  busy,
  document,
  folders,
  onClose,
  onSave,
  spaces,
  tags,
}: {
  busy: boolean;
  document: OrganizedDocument;
  folders: KnowledgeFolder[];
  onClose: () => void;
  onSave: (spaceId: string | null, folderId: string | null, tagIds: string[]) => Promise<void>;
  spaces: KnowledgeSpace[];
  tags: KnowledgeTag[];
}): ReactElement {
  const [spaceId, setSpaceId] = useState(document.spaceId ?? '');
  const [folderId, setFolderId] = useState(document.folderId ?? '');
  const [tagIds, setTagIds] = useState(document.tagIds);

  useEffect(() => {
    setSpaceId(document.spaceId ?? '');
    setFolderId(document.folderId ?? '');
    setTagIds(document.tagIds);
  }, [document]);

  return (
    <aside className="knowledge-inspector">
      <div className="knowledge-inspector-heading">
        <div>
          <FileText size={18} /> <strong>文档归档</strong>
        </div>
        <button
          aria-label="关闭文档编辑"
          className="icon-button"
          onClick={onClose}
          title="关闭"
          type="button"
        >
          <X size={15} />
        </button>
      </div>
      <h2 className="document-editor-title">{document.title}</h2>
      <EditorField label="知识空间">
        <select
          className="access-select"
          onChange={(event) => {
            setSpaceId(event.target.value);
            setFolderId('');
          }}
          value={spaceId}
        >
          <option value="">未归档</option>
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
      </EditorField>
      <EditorField label="文件夹">
        <select
          className="access-select"
          disabled={!spaceId}
          onChange={(event) => setFolderId(event.target.value)}
          value={folderId}
        >
          <option value="">空间根目录</option>
          {flattenFolders(folders, spaceId).map(({ folder, depth }) => (
            <option key={folder.id} value={folder.id}>
              {'　'.repeat(depth)}
              {folder.name}
            </option>
          ))}
        </select>
      </EditorField>
      <div className="inspector-divider" />
      <div className="inspector-section-title">
        <Tags size={16} /> <strong>标签</strong>
      </div>
      <div className="tag-check-list">
        {tags.map((tag) => (
          <label key={tag.id}>
            <input
              checked={tagIds.includes(tag.id)}
              onChange={(event) => setTagIds(toggleValue(tagIds, tag.id, event.target.checked))}
              type="checkbox"
            />
            <i style={{ background: tag.color }} />
            <span>{tag.name}</span>
          </label>
        ))}
        {tags.length === 0 ? <div className="knowledge-empty">暂无标签</div> : null}
      </div>
      <Button
        className="inspector-save"
        disabled={busy}
        onClick={() => void onSave(spaceId || null, folderId || null, tagIds)}
      >
        <Save size={15} /> 保存归档信息
      </Button>
    </aside>
  );
}

function TagManager({
  busy,
  onCreate,
  onDelete,
  onUpdate,
  readOnly,
  tags,
}: {
  busy: boolean;
  onCreate: (name: string, color: string, description: string | null) => Promise<void>;
  onDelete: (tag: KnowledgeTag) => Promise<void>;
  onUpdate: (
    tagId: string,
    name: string,
    color: string,
    description: string | null,
  ) => Promise<void>;
  readOnly: boolean;
  tags: KnowledgeTag[];
}): ReactElement {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#1769aa');
  const [description, setDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <section className="tag-manager">
      {!readOnly ? (
        <div className="tag-create-band">
          <div className="knowledge-pane-heading">
            <div>
              <strong>新建标签</strong>
              <span>{tags.length} 个标签</span>
            </div>
            <Tag size={18} />
          </div>
          <div className="tag-create-form">
            <input
              className="text-input"
              onChange={(event) => setName(event.target.value)}
              placeholder="标签名称"
              value={name}
            />
            <label className="color-input" title="标签颜色">
              <input
                onChange={(event) => setColor(event.target.value)}
                type="color"
                value={color}
              />
              <span>{color.toUpperCase()}</span>
            </label>
            <input
              className="text-input"
              onChange={(event) => setDescription(event.target.value)}
              placeholder="说明"
              value={description}
            />
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void onCreate(name.trim(), color, description.trim() || null).then(() => {
                  setName('');
                  setDescription('');
                })
              }
            >
              <Plus size={15} /> 创建标签
            </Button>
          </div>
        </div>
      ) : null}
      <div className="tag-table">
        <div className="tag-table-head">
          <span>标签</span>
          <span>说明</span>
          <span>文档数</span>
          <span>操作</span>
        </div>
        {tags.map((tag) =>
          editingId === tag.id ? (
            <TagEditRow
              busy={busy}
              key={tag.id}
              onCancel={() => setEditingId(null)}
              onSave={(nextName, nextColor, nextDescription) =>
                onUpdate(tag.id, nextName, nextColor, nextDescription).then(() =>
                  setEditingId(null),
                )
              }
              tag={tag}
            />
          ) : (
            <div className="tag-table-row" key={tag.id}>
              <span className="tag-name">
                <i style={{ background: tag.color }} /> <strong>{tag.name}</strong>
              </span>
              <span>{tag.description ?? '未填写'}</span>
              <span>{tag.documentCount}</span>
              <span className="tag-actions">
                {!readOnly ? (
                  <>
                    <button
                      aria-label={`编辑标签 ${tag.name}`}
                      className="icon-button"
                      disabled={busy}
                      onClick={() => setEditingId(tag.id)}
                      title="编辑"
                      type="button"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      aria-label={`删除标签 ${tag.name}`}
                      className="icon-button danger"
                      disabled={busy}
                      onClick={() => void onDelete(tag)}
                      title="删除"
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                ) : (
                  <span>只读</span>
                )}
              </span>
            </div>
          ),
        )}
        {tags.length === 0 ? <div className="knowledge-empty document-empty">暂无标签</div> : null}
      </div>
    </section>
  );
}

function TagEditRow({
  busy,
  onCancel,
  onSave,
  tag,
}: {
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, color: string, description: string | null) => Promise<void>;
  tag: KnowledgeTag;
}): ReactElement {
  const [name, setName] = useState(tag.name);
  const [color, setColor] = useState(tag.color);
  const [description, setDescription] = useState(tag.description ?? '');
  return (
    <div className="tag-table-row editing">
      <span className="tag-edit-name">
        <input onChange={(event) => setColor(event.target.value)} type="color" value={color} />
        <input
          className="text-input"
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </span>
      <span>
        <input
          className="text-input"
          onChange={(event) => setDescription(event.target.value)}
          value={description}
        />
      </span>
      <span>{tag.documentCount}</span>
      <span className="tag-actions">
        <button
          aria-label="保存标签"
          className="icon-button"
          disabled={busy || !name.trim()}
          onClick={() => void onSave(name.trim(), color, description.trim() || null)}
          title="保存"
          type="button"
        >
          <Check size={14} />
        </button>
        <button
          aria-label="取消编辑标签"
          className="icon-button"
          disabled={busy}
          onClick={onCancel}
          title="取消"
          type="button"
        >
          <X size={14} />
        </button>
      </span>
    </div>
  );
}

function SpaceDialog({
  busy,
  defaultPrincipalId,
  onClose,
  onCreate,
  principalChoices,
}: {
  busy: boolean;
  defaultPrincipalId: string;
  onClose: () => void;
  onCreate: (name: string, description: string | null, principalIds: string[]) => Promise<void>;
  principalChoices: PrincipalChoice[];
}): ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [principalIds, setPrincipalIds] = useState([defaultPrincipalId]);
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-labelledby="space-dialog-title"
        aria-modal="true"
        className="space-dialog"
        role="dialog"
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">知识空间</span>
            <h2 id="space-dialog-title">新建空间</h2>
          </div>
          <button
            aria-label="关闭新建空间窗口"
            className="icon-button"
            disabled={busy}
            onClick={onClose}
            title="关闭"
            type="button"
          >
            <X size={15} />
          </button>
        </div>
        <EditorField label="名称">
          <input
            className="text-input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </EditorField>
        <EditorField label="说明">
          <textarea
            className="knowledge-textarea"
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </EditorField>
        <div className="inspector-section-title space-acl-title">
          <ShieldCheck size={16} /> <strong>访问主体</strong>
        </div>
        <div className="principal-list dialog-principal-list">
          {principalChoices.map((principal) => (
            <label key={principal.id}>
              <input
                checked={principalIds.includes(principal.id)}
                onChange={(event) =>
                  setPrincipalIds(toggleValue(principalIds, principal.id, event.target.checked))
                }
                type="checkbox"
              />
              <span>
                <strong>{principal.label}</strong>
                <small>{principal.type}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="dialog-actions">
          <Button disabled={busy} onClick={onClose} variant="secondary">
            取消
          </Button>
          <Button
            disabled={busy || !name.trim() || principalIds.length === 0}
            onClick={() => void onCreate(name.trim(), description.trim() || null, principalIds)}
          >
            <Plus size={15} /> 创建空间
          </Button>
        </div>
      </section>
    </div>
  );
}

function EditorField({ children, label }: { children: ReactElement; label: string }): ReactElement {
  return (
    <label className="knowledge-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function EmptyInspector(): ReactElement {
  return (
    <aside className="knowledge-inspector empty">
      <FolderTree size={24} />
      <span>暂无知识空间</span>
    </aside>
  );
}

function flattenFolders(
  folders: KnowledgeFolder[],
  spaceId: string | null,
): Array<{ folder: KnowledgeFolder; depth: number }> {
  if (!spaceId) return [];
  const result: Array<{ folder: KnowledgeFolder; depth: number }> = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of folders.filter(
      (candidate) => candidate.spaceId === spaceId && candidate.parentId === parentId,
    )) {
      result.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

function filterDocuments(
  documents: OrganizedDocument[],
  selection: ContainerSelection | null,
): OrganizedDocument[] {
  if (!selection) return documents.filter((document) => document.spaceId === null);
  return selection.type === 'space'
    ? documents.filter((document) => document.spaceId === selection.id)
    : documents.filter((document) => document.folderId === selection.id);
}

function ReadOnlyInspector({ title }: { title: string }): ReactElement {
  return (
    <aside className="knowledge-inspector empty">
      <ShieldCheck size={24} />
      <strong>{title}</strong>
      <span>当前账号仅可查看</span>
    </aside>
  );
}

function buildPrincipalChoices(
  directory: AccessPrincipalDirectoryResponse | null,
): PrincipalChoice[] {
  if (!directory) return [];
  const labels = {
    tenant: '整个租户',
    user: '成员',
    department: '部门',
    role: '角色',
  };
  return directory.principals.map((principal) => ({
    id: principal.id,
    label: principal.label,
    type: labels[principal.type],
  }));
}

function toggleValue(values: string[], value: string, included: boolean): string[] {
  return included ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function statusLabel(status: OrganizedDocument['status']): string {
  return status === 'published' ? '已发布' : status === 'draft' ? '草稿' : '已归档';
}

const jsonHeaders = { 'Content-Type': 'application/json' };

async function requestApi<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as
    { ok: true; data: T } | { ok: false; error?: { message?: string }; message?: unknown } | null;
  if (!response.ok || !body || !body.ok) {
    throw new Error(readApiError(body) ?? `请求失败（${response.status}）`);
  }
  return body.data;
}

function readApiError(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as { error?: { message?: unknown }; message?: unknown };
  if (typeof value.error?.message === 'string') return value.error.message;
  if (typeof value.message === 'string') return value.message;
  if (value.message && typeof value.message === 'object') {
    const nested = value.message as { message?: unknown };
    if (typeof nested.message === 'string') return nested.message;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
