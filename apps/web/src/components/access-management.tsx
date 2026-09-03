'use client';

import type {
  AccessOverviewResponse,
  AccessRole,
  DocumentAclGrant,
  DocumentResourcePermissionKey,
  OrganizationDepartment,
  OrganizationMember,
  TenantAccessPermissionKey,
} from '@knowledge-base/contracts';
import { documentResourcePermissionKeys } from '@knowledge-base/contracts';
import { Button } from '@knowledge-base/ui/button';
import {
  Building2,
  FileKey2,
  LoaderCircle,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Trash2,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useAuthSession } from '@/components/auth-session-provider';

type AccessTab = 'members' | 'roles' | 'departments' | 'documents';

const tabs: Array<{ id: AccessTab; label: string; icon: typeof Users }> = [
  { id: 'members', label: '成员与角色', icon: Users },
  { id: 'roles', label: '角色权限', icon: Shield },
  { id: 'departments', label: '部门成员', icon: Building2 },
  { id: 'documents', label: '文档 ACL', icon: FileKey2 },
];

export function AccessManagement(): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const auth = useAuthSession();
  const allowed = auth.hasPermission('access.manage');
  const [overview, setOverview] = useState<AccessOverviewResponse | null>(null);
  const [activeTab, setActiveTab] = useState<AccessTab>('members');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    if (auth.loading || !allowed) {
      setLoading(auth.loading);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setOverview(await requestApi<AccessOverviewResponse>(`${apiBase}/access/overview`));
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [allowed, apiBase, auth.loading]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const mutate = useCallback(
    async (action: () => Promise<unknown>, successMessage: string) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await action();
        await loadOverview();
        setNotice(successMessage);
      } catch (mutationError) {
        setError(messageOf(mutationError));
      } finally {
        setBusy(false);
      }
    },
    [loadOverview],
  );

  if (!auth.loading && !allowed) {
    return (
      <div className="access-failure" role="alert">
        当前账号没有访问控制管理权限
      </div>
    );
  }

  if (loading && !overview) {
    return (
      <div className="access-loading" role="status">
        <LoaderCircle className="spinning" size={20} /> 正在载入访问控制数据
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="access-failure" role="alert">
        <span>{error ?? '访问控制数据载入失败'}</span>
        <Button onClick={() => void loadOverview()} variant="secondary">
          <RefreshCw size={15} /> 重试
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="metrics access-metrics" aria-label="访问控制概览">
        <div>
          <span>组织成员</span>
          <strong>{overview.members.length}</strong>
          <small>{overview.tenant.name}</small>
        </div>
        <div>
          <span>访问角色</span>
          <strong>{overview.roles.length}</strong>
          <small>{overview.roles.filter((role) => role.isSystem).length} 个系统角色</small>
        </div>
        <div>
          <span>部门</span>
          <strong>{overview.departments.length}</strong>
          <small>用于批量授权</small>
        </div>
        <div>
          <span>已纳管文档</span>
          <strong>{overview.documents.length}</strong>
          <small>ACL 实时投影</small>
        </div>
      </div>

      {error ? <div className="notice">{error}</div> : null}
      {notice ? <div className="access-success">{notice}</div> : null}

      <div className="access-toolbar">
        <div className="access-tabs" role="tablist" aria-label="访问控制视图">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                aria-selected={activeTab === tab.id}
                className={activeTab === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                type="button"
              >
                <Icon size={15} /> {tab.label}
              </button>
            );
          })}
        </div>
        <button
          aria-label="刷新访问控制数据"
          className="icon-button"
          disabled={loading || busy}
          onClick={() => void loadOverview()}
          title="刷新"
          type="button"
        >
          <RefreshCw className={loading ? 'spinning' : ''} size={16} />
        </button>
      </div>

      <div className="access-surface">
        {activeTab === 'members' ? (
          <MembersView
            apiBase={apiBase}
            busy={busy}
            members={overview.members}
            mutate={mutate}
            roles={overview.roles}
          />
        ) : null}
        {activeTab === 'roles' ? (
          <RolesView apiBase={apiBase} busy={busy} mutate={mutate} overview={overview} />
        ) : null}
        {activeTab === 'departments' ? (
          <DepartmentsView
            apiBase={apiBase}
            busy={busy}
            departments={overview.departments}
            members={overview.members}
            mutate={mutate}
          />
        ) : null}
        {activeTab === 'documents' ? (
          <DocumentsAclView apiBase={apiBase} busy={busy} mutate={mutate} overview={overview} />
        ) : null}
      </div>
    </>
  );
}

type Mutate = (action: () => Promise<unknown>, successMessage: string) => Promise<void>;

function MembersView({
  apiBase,
  busy,
  members,
  mutate,
  roles,
}: {
  apiBase: string;
  busy: boolean;
  members: OrganizationMember[];
  mutate: Mutate;
  roles: AccessRole[];
}): ReactElement {
  const [memberId, setMemberId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [selectedMemberId, setSelectedMemberId] = useState(members[0]?.id ?? '');
  const selectedMember = members.find((member) => member.id === selectedMemberId) ?? members[0];
  const [roleIds, setRoleIds] = useState<string[]>(selectedMember?.roleIds ?? []);

  useEffect(() => {
    setRoleIds(selectedMember?.roleIds ?? []);
  }, [selectedMember?.id, selectedMember?.roleIds]);

  async function createMember(): Promise<void> {
    await mutate(
      () =>
        requestApi(`${apiBase}/access/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: memberId, displayName, email: email.trim() || null }),
        }),
      '成员已保存',
    );
    setMemberId('');
    setDisplayName('');
    setEmail('');
  }

  return (
    <section className="access-view" role="tabpanel">
      <div className="access-section-heading">
        <div>
          <h2>组织成员</h2>
          <p>成员身份来自企业身份源，此处维护本地授权投影。</p>
        </div>
        <UserRoundPlus size={20} />
      </div>
      <div className="access-form-grid member-form">
        <Field label="用户 UUID">
          <input
            className="text-input"
            onChange={(event) => setMemberId(event.target.value)}
            placeholder="00000000-0000-4000-8000-000000000000"
            value={memberId}
          />
        </Field>
        <Field label="显示名称">
          <input
            className="text-input"
            onChange={(event) => setDisplayName(event.target.value)}
            value={displayName}
          />
        </Field>
        <Field label="邮箱">
          <input
            className="text-input"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </Field>
        <Button
          disabled={busy || !memberId || !displayName.trim()}
          onClick={() => void createMember()}
        >
          <Plus size={15} /> 保存成员
        </Button>
      </div>

      <div className="access-divider" />
      <div className="access-editor-grid">
        <div>
          <label className="field-label" htmlFor="member-role-target">
            目标成员
          </label>
          <select
            className="access-select"
            id="member-role-target"
            onChange={(event) => setSelectedMemberId(event.target.value)}
            value={selectedMember?.id ?? ''}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="access-check-list">
          {roles.map((role) => (
            <CheckboxRow
              checked={roleIds.includes(role.id)}
              description={`${role.memberCount} 位成员${role.isSystem ? ' · 系统角色' : ''}`}
              disabled={role.isSystem}
              key={role.id}
              label={role.name}
              onChange={(checked) => setRoleIds(toggleValue(roleIds, role.id, checked))}
            />
          ))}
        </div>
      </div>
      <div className="access-actions">
        <Button
          disabled={busy || !selectedMember}
          onClick={() =>
            selectedMember &&
            void mutate(
              () =>
                requestApi(`${apiBase}/access/members/${selectedMember.id}/roles`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ roleIds }),
                }),
              '成员角色已更新',
            )
          }
        >
          <Save size={15} /> 保存角色
        </Button>
      </div>
    </section>
  );
}

function RolesView({
  apiBase,
  busy,
  mutate,
  overview,
}: {
  apiBase: string;
  busy: boolean;
  mutate: Mutate;
  overview: AccessOverviewResponse;
}): ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [permissionKeys, setPermissionKeys] = useState<TenantAccessPermissionKey[]>([]);

  async function createRole(): Promise<void> {
    await mutate(
      () =>
        requestApi(`${apiBase}/access/roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description: description.trim() || null, permissionKeys }),
        }),
      '角色已创建',
    );
    setName('');
    setDescription('');
    setPermissionKeys([]);
  }

  return (
    <section className="access-view" role="tabpanel">
      <div className="access-section-heading">
        <div>
          <h2>新建角色</h2>
          <p>角色聚合租户级操作能力，并可作为文档 ACL 主体。</p>
        </div>
        <Shield size={20} />
      </div>
      <div className="access-form-grid role-form">
        <Field label="角色名称">
          <input
            className="text-input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field label="说明">
          <input
            className="text-input"
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </Field>
      </div>
      <div className="permission-grid">
        {overview.permissions
          .filter((permission) => permission.scope === 'tenant')
          .map((permission) => {
            const permissionKey = permission.key as TenantAccessPermissionKey;
            return (
              <CheckboxRow
                checked={permissionKeys.includes(permissionKey)}
                description={permission.description}
                key={permissionKey}
                label={permission.name}
                onChange={(checked) =>
                  setPermissionKeys(toggleValue(permissionKeys, permissionKey, checked))
                }
              />
            );
          })}
      </div>
      <div className="access-actions">
        <Button disabled={busy || !name.trim()} onClick={() => void createRole()}>
          <Plus size={15} /> 创建角色
        </Button>
      </div>
      <div className="access-divider" />
      <div className="access-table" role="table" aria-label="角色列表">
        {overview.roles.map((role) => (
          <div className="access-table-row role-row" key={role.id} role="row">
            <div>
              <strong>{role.name}</strong>
              <span>{role.description ?? '暂无说明'}</span>
            </div>
            <span>{role.permissionKeys.length} 项权限</span>
            <span>{role.memberCount} 位成员</span>
            <button
              aria-label={`删除角色 ${role.name}`}
              className="icon-button danger"
              disabled={busy || role.isSystem}
              onClick={() =>
                void mutate(
                  () => requestApi(`${apiBase}/access/roles/${role.id}`, { method: 'DELETE' }),
                  '角色已删除',
                )
              }
              title={role.isSystem ? '系统角色不可删除' : '删除角色'}
              type="button"
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function DepartmentsView({
  apiBase,
  busy,
  departments,
  members,
  mutate,
}: {
  apiBase: string;
  busy: boolean;
  departments: OrganizationDepartment[];
  members: OrganizationMember[];
  mutate: Mutate;
}): ReactElement {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [departmentId, setDepartmentId] = useState(departments[0]?.id ?? '');
  const department = departments.find((item) => item.id === departmentId) ?? departments[0];
  const [userIds, setUserIds] = useState<string[]>(department?.memberIds ?? []);
  useEffect(() => setUserIds(department?.memberIds ?? []), [department?.id, department?.memberIds]);

  return (
    <section className="access-view" role="tabpanel">
      <div className="access-section-heading">
        <div>
          <h2>部门结构</h2>
          <p>部门成员会在登录时展开为有效访问主体。</p>
        </div>
        <Building2 size={20} />
      </div>
      <div className="access-form-grid role-form">
        <Field label="部门名称">
          <input
            className="text-input"
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field label="说明">
          <input
            className="text-input"
            onChange={(event) => setDescription(event.target.value)}
            value={description}
          />
        </Field>
        <Button
          disabled={busy || !name.trim()}
          onClick={() =>
            void mutate(
              () =>
                requestApi(`${apiBase}/access/departments`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ name, description: description.trim() || null }),
                }),
              '部门已创建',
            ).then(() => {
              setName('');
              setDescription('');
            })
          }
        >
          <Plus size={15} /> 创建部门
        </Button>
      </div>
      <div className="access-divider" />
      {departments.length > 0 ? (
        <>
          <label className="field-label" htmlFor="department-target">
            目标部门
          </label>
          <select
            className="access-select"
            id="department-target"
            onChange={(event) => setDepartmentId(event.target.value)}
            value={department?.id ?? ''}
          >
            {departments.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <div className="permission-grid member-check-grid">
            {members.map((member) => (
              <CheckboxRow
                checked={userIds.includes(member.id)}
                description={member.email ?? member.id}
                key={member.id}
                label={member.displayName}
                onChange={(checked) => setUserIds(toggleValue(userIds, member.id, checked))}
              />
            ))}
          </div>
          <div className="access-actions">
            <Button
              disabled={busy || !department}
              onClick={() =>
                department &&
                void mutate(
                  () =>
                    requestApi(`${apiBase}/access/departments/${department.id}/members`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ userIds }),
                    }),
                  '部门成员已更新',
                )
              }
            >
              <Save size={15} /> 保存成员
            </Button>
          </div>
        </>
      ) : (
        <div className="access-empty">尚未创建部门</div>
      )}
    </section>
  );
}

function DocumentsAclView({
  apiBase,
  busy,
  mutate,
  overview,
}: {
  apiBase: string;
  busy: boolean;
  mutate: Mutate;
  overview: AccessOverviewResponse;
}): ReactElement {
  const [documentId, setDocumentId] = useState(overview.documents[0]?.id ?? '');
  const document =
    overview.documents.find((item) => item.id === documentId) ?? overview.documents[0];
  const [grants, setGrants] = useState<DocumentAclGrant[]>(document?.directGrants ?? []);
  useEffect(() => setGrants(document?.directGrants ?? []), [document?.directGrants, document?.id]);
  const principals = useMemo(
    () => [
      { id: `tenant:${overview.tenant.id}`, label: overview.tenant.name, description: '整个租户' },
      ...overview.members.map((member) => ({
        id: `user:${member.id}`,
        label: member.displayName,
        description: '成员',
      })),
      ...overview.roles.map((role) => ({
        id: `role:${role.id}`,
        label: role.name,
        description: '角色',
      })),
      ...overview.departments.map((department) => ({
        id: `department:${department.id}`,
        label: department.name,
        description: '部门',
      })),
    ],
    [overview],
  );
  const directReadPrincipalIds = new Set(
    grants
      .filter((grant) => grant.permissions.includes('documents.read'))
      .map((grant) => grant.principalId),
  );
  const inheritedPrincipalIds = document
    ? document.effectivePrincipalIds.filter(
        (principalId) => !directReadPrincipalIds.has(principalId),
      )
    : [];

  if (!document)
    return (
      <section className="access-view">
        <div className="access-empty">当前没有可配置的文档</div>
      </section>
    );
  return (
    <section className="access-view" role="tabpanel">
      <div className="access-section-heading">
        <div>
          <h2>文档访问列表</h2>
          <p>变更提交后由可靠队列刷新全文搜索索引。</p>
        </div>
        <FileKey2 size={20} />
      </div>
      <label className="field-label" htmlFor="acl-document">
        目标文档
      </label>
      <select
        className="access-select"
        id="acl-document"
        onChange={(event) => setDocumentId(event.target.value)}
        value={document.id}
      >
        {overview.documents.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title} · ACL v{item.aclVersion}
          </option>
        ))}
      </select>
      <div className="permission-grid acl-grid">
        {principals.map((principal) => {
          const grant = grants.find((item) => item.principalId === principal.id);
          return (
            <div className="access-check" key={principal.id}>
              <span>
                <strong>{principal.label}</strong>
                <small>{principal.description}</small>
              </span>
              <div className="acl-permission-options">
                {documentResourcePermissionKeys.map((permission) => (
                  <label key={permission}>
                    <input
                      checked={grant?.permissions.includes(permission) ?? false}
                      onChange={(event) =>
                        setGrants(
                          toggleDocumentGrant(
                            grants,
                            principal.id,
                            permission,
                            event.target.checked,
                          ),
                        )
                      }
                      type="checkbox"
                    />
                    <span>{documentPermissionLabel(permission)}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {inheritedPrincipalIds.length > 0 ? (
        <p className="inherit-note">
          另有 {inheritedPrincipalIds.length}{' '}
          个主体通过空间或文件夹继承读取权限；此处保存不会将其转成文档直接授权。
        </p>
      ) : null}
      <div className="access-actions">
        <Button
          disabled={busy}
          onClick={() =>
            void mutate(
              () =>
                requestApi(`${apiBase}/access/documents/${document.id}/acl`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ grants }),
                }),
              '文档 ACL 已提交投影',
            )
          }
        >
          <Save size={15} /> 保存 ACL
        </Button>
      </div>
    </section>
  );
}

function Field({ children, label }: { children: ReactElement; label: string }): ReactElement {
  return (
    <label>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

function CheckboxRow({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className={disabled ? 'access-check disabled' : 'access-check'}>
      <input
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
    </label>
  );
}

function toggleValue<T extends string>(values: T[], value: T, included: boolean): T[] {
  return included ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function toggleDocumentGrant(
  grants: DocumentAclGrant[],
  principalId: string,
  permission: DocumentResourcePermissionKey,
  included: boolean,
): DocumentAclGrant[] {
  const current = grants.find((grant) => grant.principalId === principalId);
  const permissions = toggleValue(current?.permissions ?? [], permission, included);
  const remaining = grants.filter((grant) => grant.principalId !== principalId);
  return permissions.length > 0 ? [...remaining, { principalId, permissions }] : remaining;
}

function documentPermissionLabel(permission: DocumentResourcePermissionKey): string {
  return {
    'documents.read': '读取',
    'documents.update': '更新',
    'documents.delete': '删除',
    'documents.manage': '管理',
    'documents.share': '共享',
  }[permission];
}

async function requestApi<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as
    { ok: true; data: T } | { ok: false; error?: { message?: string }; message?: unknown } | null;
  if (!response.ok || !body || !body.ok)
    throw new Error(readApiError(body) ?? `请求失败（${response.status}）`);
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
