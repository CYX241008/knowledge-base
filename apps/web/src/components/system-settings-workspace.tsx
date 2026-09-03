'use client';

import type {
  AuditEventItem,
  AuditEventListResponse,
  HealthResponse,
  QualityCostResponse,
  SearchFeedbackReason,
  SystemRuntimeConfiguration,
  SystemSettingsResponse,
  UpdateSystemSettingsRequest,
} from '@knowledge-base/contracts';
import { Button } from '@knowledge-base/ui/button';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  CircleDollarSign,
  Database,
  FileClock,
  Gauge,
  LoaderCircle,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

type SettingsView = 'runtime' | 'audit' | 'quality';

const tabs: Array<{ id: SettingsView; label: string; icon: typeof Settings2 }> = [
  { id: 'runtime', label: '运行设置', icon: SlidersHorizontal },
  { id: 'audit', label: '审计日志', icon: FileClock },
  { id: 'quality', label: '质量与成本', icon: Gauge },
];

export function SystemSettingsWorkspace(): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedView = searchParams.get('view');
  const view: SettingsView =
    requestedView === 'audit' || requestedView === 'quality' ? requestedView : 'runtime';

  const [settings, setSettings] = useState<SystemSettingsResponse | null>(null);
  const [draft, setDraft] = useState<UpdateSystemSettingsRequest | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [audit, setAudit] = useState<AuditEventListResponse | null>(null);
  const [quality, setQuality] = useState<QualityCostResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewLoading, setViewLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [settingsAllowed, setSettingsAllowed] = useState(true);
  const [auditAllowed, setAuditAllowed] = useState(true);
  const [qualityAllowed, setQualityAllowed] = useState(true);
  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState('');
  const [auditResourceType, setAuditResourceType] = useState('');
  const [auditActionDraft, setAuditActionDraft] = useState('');
  const [auditResourceDraft, setAuditResourceDraft] = useState('');
  const [qualityDays, setQualityDays] = useState(30);

  const setView = useCallback(
    (nextView: SettingsView) => {
      setNotice(null);
      const params = new URLSearchParams(searchParams.toString());
      if (nextView === 'runtime') params.delete('view');
      else params.set('view', nextView);
      const next = params.toString();
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, healthResult] = await Promise.allSettled([
        requestApi<SystemSettingsResponse>(`${apiBase}/admin/settings`),
        requestApi<HealthResponse>(`${apiBase}/health`),
      ]);
      if (settingsResult.status === 'rejected') throw settingsResult.reason;
      setSettings(settingsResult.value);
      setDraft({
        retrieval: settingsResult.value.retrieval,
        governance: settingsResult.value.governance,
      });
      setSettingsAllowed(true);
      setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 403) setSettingsAllowed(false);
      else setError(messageOf(loadError));
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  const loadAudit = useCallback(async () => {
    setViewLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(auditPage), pageSize: '30' });
    if (auditAction) params.set('action', auditAction);
    if (auditResourceType) params.set('resourceType', auditResourceType);
    try {
      setAudit(await requestApi<AuditEventListResponse>(`${apiBase}/admin/audit?${params}`));
      setAuditAllowed(true);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 403) setAuditAllowed(false);
      else setError(messageOf(loadError));
    } finally {
      setViewLoading(false);
    }
  }, [apiBase, auditAction, auditPage, auditResourceType]);

  const loadQuality = useCallback(async () => {
    setViewLoading(true);
    setError(null);
    try {
      setQuality(
        await requestApi<QualityCostResponse>(`${apiBase}/admin/quality?days=${qualityDays}`),
      );
      setQualityAllowed(true);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 403) setQualityAllowed(false);
      else setError(messageOf(loadError));
    } finally {
      setViewLoading(false);
    }
  }, [apiBase, qualityDays]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (view === 'audit') void loadAudit();
    if (view === 'quality') void loadQuality();
  }, [loadAudit, loadQuality, view]);

  async function saveSettings(): Promise<void> {
    if (!draft || !settings?.canEdit) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await requestApi<SystemSettingsResponse>(`${apiBase}/admin/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setSettings(updated);
      setDraft({ retrieval: updated.retrieval, governance: updated.governance });
      setNotice(`设置已保存，当前版本 ${updated.version}`);
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setSaving(false);
    }
  }

  function submitAuditFilters(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setAuditPage(1);
    setAuditAction(auditActionDraft.trim());
    setAuditResourceType(auditResourceDraft.trim());
  }

  const auditPages = audit ? Math.max(1, Math.ceil(audit.total / audit.pageSize)) : 1;
  const dirty = Boolean(
    settings && draft && JSON.stringify(draft) !== JSON.stringify(pickEditable(settings)),
  );

  return (
    <>
      <header className="topbar settings-topbar">
        <div>
          <span className="eyebrow">平台治理</span>
          <h1>系统设置</h1>
        </div>
        <a className="management-link" href="/admin/access">
          <ShieldCheck size={15} /> 组织与权限
        </a>
      </header>

      <div className="settings-toolbar">
        <div className="settings-tabs" role="tablist" aria-label="系统治理视图">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                aria-selected={view === tab.id}
                className={view === tab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => setView(tab.id)}
                role="tab"
                type="button"
              >
                <Icon size={15} /> {tab.label}
              </button>
            );
          })}
        </div>
        <button
          aria-label="刷新当前视图"
          className="icon-button"
          disabled={loading || viewLoading}
          onClick={() =>
            view === 'audit'
              ? void loadAudit()
              : view === 'quality'
                ? void loadQuality()
                : void loadSettings()
          }
          title="刷新"
          type="button"
        >
          <RefreshCw className={loading || viewLoading ? 'spinning' : ''} size={16} />
        </button>
      </div>

      {error ? <div className="notice">{error}</div> : null}
      {notice ? <div className="access-success">{notice}</div> : null}

      {loading && !settings ? (
        <SettingsEmpty
          icon={<LoaderCircle className="spinning" size={22} />}
          title="正在载入系统设置"
        />
      ) : !settingsAllowed ? (
        <SettingsEmpty icon={<ShieldCheck size={22} />} title="无权访问系统治理" />
      ) : view === 'runtime' ? (
        settings && draft ? (
          <RuntimeSettingsView
            draft={draft}
            health={health}
            onChange={setDraft}
            onSave={() => void saveSettings()}
            saving={saving}
            settings={settings}
            dirty={dirty}
          />
        ) : (
          <SettingsEmpty icon={<Settings2 size={22} />} title="系统设置载入失败" />
        )
      ) : view === 'audit' ? (
        auditAllowed ? (
          <AuditView
            actionDraft={auditActionDraft}
            audit={audit}
            currentPage={auditPage}
            loading={viewLoading}
            onActionDraftChange={setAuditActionDraft}
            onPageChange={setAuditPage}
            onResourceDraftChange={setAuditResourceDraft}
            onSubmit={submitAuditFilters}
            resourceDraft={auditResourceDraft}
            totalPages={auditPages}
          />
        ) : (
          <SettingsEmpty icon={<FileClock size={22} />} title="无权查看完整审计日志" />
        )
      ) : qualityAllowed ? (
        <QualityView
          data={quality}
          days={qualityDays}
          loading={viewLoading}
          onDaysChange={setQualityDays}
        />
      ) : (
        <SettingsEmpty icon={<Gauge size={22} />} title="无权查看质量与成本数据" />
      )}
    </>
  );
}

function RuntimeSettingsView({
  dirty,
  draft,
  health,
  onChange,
  onSave,
  saving,
  settings,
}: {
  dirty: boolean;
  draft: UpdateSystemSettingsRequest;
  health: HealthResponse | null;
  onChange: (value: UpdateSystemSettingsRequest) => void;
  onSave: () => void;
  saving: boolean;
  settings: SystemSettingsResponse;
}): ReactElement {
  return (
    <section className="settings-surface" role="tabpanel">
      <div className="settings-section-heading">
        <div>
          <h2>租户运行参数</h2>
          <p>保存后立即作用于新的全文检索请求。</p>
        </div>
        <span className="settings-version">版本 {settings.version}</span>
      </div>
      <div className="settings-form-grid">
        <NumberSetting
          description="参与混合召回与排序的最大候选数量。"
          disabled={!settings.canEdit}
          label="候选窗口"
          max={500}
          min={50}
          onChange={(candidateLimit) =>
            onChange({ ...draft, retrieval: { ...draft.retrieval, candidateLimit } })
          }
          step={10}
          value={draft.retrieval.candidateLimit}
        />
        <NumberSetting
          description="过滤低于该相关性得分的结果。"
          disabled={!settings.canEdit}
          label="最低相关性"
          max={1}
          min={0}
          onChange={(scoreThreshold) =>
            onChange({ ...draft, retrieval: { ...draft.retrieval, scoreThreshold } })
          }
          step={0.05}
          value={draft.retrieval.scoreThreshold}
        />
        <NumberSetting
          description="独立全文搜索每页默认显示数量。"
          disabled={!settings.canEdit}
          label="默认分页数"
          max={50}
          min={5}
          onChange={(defaultPageSize) =>
            onChange({ ...draft, retrieval: { ...draft.retrieval, defaultPageSize } })
          }
          step={5}
          value={draft.retrieval.defaultPageSize}
        />
        <NumberSetting
          description="超过保留周期的租户审计事件会被清理。"
          disabled={!settings.canEdit}
          label="审计保留天数"
          max={3650}
          min={30}
          onChange={(auditRetentionDays) =>
            onChange({ ...draft, governance: { auditRetentionDays } })
          }
          step={30}
          value={draft.governance.auditRetentionDays}
        />
        <label className="settings-toggle-row">
          <span>
            <strong>收集检索反馈</strong>
            <small>允许用户标记搜索结果是否有用并补充原因。</small>
          </span>
          <input
            checked={draft.retrieval.feedbackEnabled}
            disabled={!settings.canEdit}
            onChange={(event) =>
              onChange({
                ...draft,
                retrieval: { ...draft.retrieval, feedbackEnabled: event.target.checked },
              })
            }
            role="switch"
            type="checkbox"
          />
        </label>
      </div>
      <div className="settings-save-row">
        <span>
          {settings.updatedAt
            ? `最近更新 ${formatDate(settings.updatedAt)}`
            : '当前使用租户默认配置'}
        </span>
        <Button disabled={!settings.canEdit || !dirty || saving} onClick={onSave}>
          {saving ? <LoaderCircle className="spinning" size={15} /> : <Save size={15} />}
          保存设置
        </Button>
      </div>

      <div className="settings-divider" />
      <div className="settings-section-heading">
        <div>
          <h2>部署运行配置</h2>
          <p>由环境变量控制，修改后需要重新部署服务。</p>
        </div>
        <Database size={19} />
      </div>
      <RuntimeTable runtime={settings.runtime} />

      <div className="settings-divider" />
      <div className="settings-section-heading">
        <div>
          <h2>依赖状态</h2>
          <p>来自 API 实例的实时健康检查。</p>
        </div>
        <Activity size={19} />
      </div>
      <div className="dependency-grid">
        {health?.dependencies ? (
          Object.entries(health.dependencies).map(([name]) => (
            <div key={name}>
              <CheckCircle2 size={15} />
              <span>{dependencyLabel(name)}</span>
              <strong>正常</strong>
            </div>
          ))
        ) : (
          <p>健康检查当前不可用</p>
        )}
      </div>
    </section>
  );
}

function NumberSetting({
  description,
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  value,
}: {
  description: string;
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  value: number;
}): ReactElement {
  return (
    <label className="settings-number-field">
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.target.value))}
        step={step}
        type="number"
        value={value}
      />
    </label>
  );
}

function RuntimeTable({ runtime }: { runtime: SystemRuntimeConfiguration }): ReactElement {
  const rows = [
    ['模型提供方', runtime.modelProvider],
    ['向量模型', runtime.embeddingModel],
    ['对话模型', runtime.chatModel],
    ['重排服务', `${runtime.rerankerProvider} / ${runtime.rerankerModel}`],
    ['MMR 相关性权重', runtime.mmrLambda.toString()],
    ['近重复相似度阈值', runtime.nearDuplicateThreshold.toString()],
    ['问答相关性阈值', runtime.ragMinRelevance.toString()],
    ['模型超时', `${runtime.modelRequestTimeoutMs.toLocaleString('zh-CN')} ms`],
    ['请求限额', `${runtime.modelRequestsPerMinute.toLocaleString('zh-CN')} 次/分钟`],
    ['上传上限', formatBytes(runtime.maxUploadSizeBytes)],
    ['会话保留', `${runtime.chatRetentionDays} 天`],
    ['检索索引', runtime.elasticsearchIndex],
  ];
  return (
    <dl className="runtime-config-grid">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AuditView({
  actionDraft,
  audit,
  currentPage,
  loading,
  onActionDraftChange,
  onPageChange,
  onResourceDraftChange,
  onSubmit,
  resourceDraft,
  totalPages,
}: {
  actionDraft: string;
  audit: AuditEventListResponse | null;
  currentPage: number;
  loading: boolean;
  onActionDraftChange: (value: string) => void;
  onPageChange: (value: number) => void;
  onResourceDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  resourceDraft: string;
  totalPages: number;
}): ReactElement {
  return (
    <section className="settings-surface" role="tabpanel">
      <div className="settings-section-heading">
        <div>
          <h2>租户审计日志</h2>
          <p>按行为与资源定位权限、知识组织和系统配置变更。</p>
        </div>
        {loading ? <LoaderCircle className="spinning" size={19} /> : <FileClock size={19} />}
      </div>
      <form className="audit-filter-form" onSubmit={onSubmit}>
        <label>
          <span>行为</span>
          <input
            onChange={(event) => onActionDraftChange(event.target.value)}
            placeholder="例如 system.settings.updated"
            value={actionDraft}
          />
        </label>
        <label>
          <span>资源类型</span>
          <input
            onChange={(event) => onResourceDraftChange(event.target.value)}
            placeholder="例如 tenant"
            value={resourceDraft}
          />
        </label>
        <Button type="submit">
          <Search size={15} /> 筛选
        </Button>
      </form>
      <div className="audit-table-scroll">
        <table className="governance-table audit-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>操作者</th>
              <th>行为</th>
              <th>资源</th>
              <th>详情</th>
            </tr>
          </thead>
          <tbody>
            {audit?.items.length ? (
              audit.items.map((item) => <AuditRow item={item} key={item.id} />)
            ) : (
              <tr>
                <td className="table-empty" colSpan={5}>
                  {loading ? '正在载入审计事件' : '当前筛选条件下没有审计事件'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="audit-pagination">
        <span>共 {audit?.total ?? 0} 条</span>
        <div>
          <button
            aria-label="上一页"
            disabled={currentPage <= 1 || loading}
            onClick={() => onPageChange(currentPage - 1)}
            title="上一页"
            type="button"
          >
            <ArrowLeft size={15} />
          </button>
          <span>
            {currentPage} / {totalPages}
          </span>
          <button
            aria-label="下一页"
            disabled={currentPage >= totalPages || loading}
            onClick={() => onPageChange(currentPage + 1)}
            title="下一页"
            type="button"
          >
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </section>
  );
}

function AuditRow({ item }: { item: AuditEventItem }): ReactElement {
  return (
    <tr>
      <td>{formatDate(item.createdAt)}</td>
      <td>
        <strong>{item.actorName ?? '系统'}</strong>
        {item.actorId ? <code>{item.actorId.slice(0, 8)}</code> : null}
      </td>
      <td>
        <strong>{actionLabel(item.action)}</strong>
        <code>{item.action}</code>
      </td>
      <td>
        <span>{resourceLabel(item.resourceType)}</span>
        {item.resourceId ? <code>{item.resourceId.slice(0, 8)}</code> : null}
      </td>
      <td title={JSON.stringify(item.metadata)}>{metadataSummary(item.metadata)}</td>
    </tr>
  );
}

function QualityView({
  data,
  days,
  loading,
  onDaysChange,
}: {
  data: QualityCostResponse | null;
  days: number;
  loading: boolean;
  onDaysChange: (value: number) => void;
}): ReactElement {
  if (loading && !data) {
    return (
      <SettingsEmpty
        icon={<LoaderCircle className="spinning" size={22} />}
        title="正在汇总质量与成本"
      />
    );
  }
  if (!data) return <SettingsEmpty icon={<Gauge size={22} />} title="暂无质量数据" />;
  return (
    <section className="quality-view" role="tabpanel">
      <div className="quality-toolbar">
        <div>
          <strong>质量与成本概览</strong>
          <span>检索与反馈按租户统计；模型指标来自当前 API 实例。</span>
        </div>
        <label>
          <CalendarDays size={15} />
          <select
            aria-label="质量统计时间范围"
            onChange={(event) => onDaysChange(Number(event.target.value))}
            value={days}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
        </label>
      </div>
      <div className="quality-metrics">
        <QualityMetric
          detail={`零结果率 ${formatPercent(data.search.zeroResultRate)}`}
          label="检索请求"
          value={data.search.totalQueries.toLocaleString('zh-CN')}
        />
        <QualityMetric
          detail={`平均 ${formatDecimal(data.search.averageResultCount)} 条结果`}
          label="平均检索耗时"
          value={`${Math.round(data.search.averageDurationMs)} ms`}
        />
        <QualityMetric
          detail={`${data.feedback.helpful} 有用 · ${data.feedback.unhelpful} 无用`}
          label="反馈有用率"
          value={formatPercent(data.feedback.helpfulRate)}
        />
        <QualityMetric
          detail={`${data.models.totalTokens.toLocaleString('zh-CN')} tokens`}
          label="实例估算成本"
          value={formatUsd(data.models.estimatedCostUsd)}
        />
      </div>
      <div className="quality-grid">
        <section className="quality-reasons">
          <div className="settings-section-heading compact">
            <div>
              <h2>无用反馈原因</h2>
              <p>用于识别内容与召回治理重点。</p>
            </div>
            <CircleDollarSign size={18} />
          </div>
          {data.feedback.reasons.length ? (
            <ol>
              {data.feedback.reasons.map((item) => (
                <li key={item.reason ?? 'unspecified'}>
                  <span>{feedbackReasonLabel(item.reason)}</span>
                  <strong>{item.count}</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p className="quality-empty">暂无反馈原因数据</p>
          )}
        </section>
        <section className="model-operations">
          <div className="settings-section-heading compact">
            <div>
              <h2>模型调用</h2>
              <p>实例启动于 {formatDate(data.models.startedAt)}</p>
            </div>
            <Activity size={18} />
          </div>
          <div className="audit-table-scroll">
            <table className="governance-table">
              <thead>
                <tr>
                  <th>操作 / 模型</th>
                  <th>调用</th>
                  <th>错误</th>
                  <th>平均耗时</th>
                  <th>Tokens</th>
                  <th>估算成本</th>
                </tr>
              </thead>
              <tbody>
                {data.models.operations.length ? (
                  data.models.operations.map((item) => (
                    <tr key={`${item.operation}-${item.model}`}>
                      <td>
                        <strong>{item.operation}</strong>
                        <code>{item.model}</code>
                      </td>
                      <td>{item.calls}</td>
                      <td>{item.errors}</td>
                      <td>{Math.round(item.averageDurationMs)} ms</td>
                      <td>{(item.inputTokens + item.outputTokens).toLocaleString('zh-CN')}</td>
                      <td>{formatUsd(item.estimatedCostUsd)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="table-empty" colSpan={6}>
                      当前实例尚无模型调用
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </section>
  );
}

function QualityMetric({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: string;
}): ReactElement {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function SettingsEmpty({ icon, title }: { icon: ReactNode; title: string }): ReactElement {
  return (
    <div className="settings-empty">
      {icon}
      <strong>{title}</strong>
    </div>
  );
}

export function SystemSettingsWorkspaceFallback(): ReactElement {
  return (
    <div className="settings-page-loading" role="status">
      <LoaderCircle className="spinning" size={21} /> 正在载入系统治理
    </div>
  );
}

function pickEditable(settings: SystemSettingsResponse): UpdateSystemSettingsRequest {
  return { retrieval: settings.retrieval, governance: settings.governance };
}

function dependencyLabel(value: string): string {
  return (
    {
      postgres: 'PostgreSQL',
      redis: 'Redis',
      minio: 'MinIO',
      elasticsearch: 'Elasticsearch',
      models: '模型契约',
      modelQuota: '模型限流',
    }[value] ?? value
  );
}

function actionLabel(value: string): string {
  const labels: Record<string, string> = {
    'system.settings.updated': '系统设置已更新',
    'access.member.upserted': '成员已保存',
    'access.role.created': '角色已创建',
    'access.role.deleted': '角色已删除',
    'access.member.roles.updated': '成员角色已更新',
    'access.department.created': '部门已创建',
    'access.department.members.updated': '部门成员已更新',
    'document.acl.replaced': '文档 ACL 已更新',
    'document.version.created': '文档版本已创建',
    'document.ingestion.requested': '文档处理已提交',
    'document.version.published': '文档版本已发布',
    'document.archived': '文档已归档',
    'space.created': '知识空间已创建',
    'space.updated': '知识空间已更新',
    'space.deleted': '知识空间已删除',
    'space.acl.replaced': '知识空间 ACL 已更新',
    'folder.created': '文件夹已创建',
    'folder.updated': '文件夹已更新',
    'folder.deleted': '文件夹已删除',
    'folder.acl.replaced': '文件夹 ACL 已更新',
    'tag.created': '标签已创建',
    'tag.updated': '标签已更新',
    'tag.deleted': '标签已删除',
    'document.moved': '文档位置已更新',
    'document.tags.replaced': '文档标签已更新',
  };
  return labels[value] ?? value;
}

function resourceLabel(value: string): string {
  return (
    {
      tenant: '租户',
      user: '用户',
      role: '角色',
      department: '部门',
      document: '文档',
      space: '知识空间',
      folder: '文件夹',
      tag: '标签',
    }[value] ?? value
  );
}

function metadataSummary(metadata: Record<string, unknown>): string {
  const keys = Object.keys(metadata);
  if (!keys.length) return '-';
  return keys
    .slice(0, 3)
    .map((key) => `${key}: ${compactValue(metadata[key])}`)
    .join(' · ');
}

function compactValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `${value.length} 项`;
  if (typeof value === 'object') return `${Object.keys(value as object).length} 字段`;
  const text = String(value);
  return text.length > 32 ? `${text.slice(0, 29)}...` : text;
}

function feedbackReasonLabel(reason: SearchFeedbackReason | null): string {
  if (!reason) return '未说明';
  return {
    irrelevant: '结果不相关',
    incomplete: '信息不完整',
    outdated: '内容已过时',
    incorrect: '内容不正确',
    other: '其他',
  }[reason];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${formatDecimal(value / 1024 ** 3)} GB`;
  if (value >= 1024 ** 2) return `${formatDecimal(value / 1024 ** 2)} MB`;
  return `${formatDecimal(value / 1024)} KB`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 0)}%`;
}

function formatDecimal(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function requestApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => null)) as
    { ok: true; data: T } | { ok: false; error?: { message?: string }; message?: unknown } | null;
  if (!response.ok || !body || !body.ok) {
    throw new ApiError(readApiError(body) ?? `请求失败（${response.status}）`, response.status);
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
