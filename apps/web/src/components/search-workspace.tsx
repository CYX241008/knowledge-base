'use client';

import type {
  KnowledgeFolder,
  KnowledgeOverviewResponse,
  KnowledgeSpace,
  SearchDocumentHit,
  SearchDocumentsResponse,
  SearchFacetValue,
  SearchFeedbackRating,
  SearchFeedbackReason,
  SearchGovernanceQueryItem,
  SearchGovernanceResponse,
  SearchPreferencesResponse,
} from '@knowledge-base/contracts';
import { Button } from '@knowledge-base/ui/button';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CalendarDays,
  FileSearch,
  FileText,
  Filter,
  Folder,
  LoaderCircle,
  RefreshCw,
  Search,
  Tags,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

type View = 'results' | 'governance';
type FilterState = { spaceId: string; folderId: string; tagIds: string[] };

const emptyFilters: FilterState = { spaceId: '', folderId: '', tagIds: [] };

export function SearchWorkspace(): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlState = searchParams.toString();
  const view: View = searchParams.get('view') === 'governance' ? 'governance' : 'results';
  const query = searchParams.get('q')?.trim() ?? '';
  const page = positiveInteger(searchParams.get('page'), 1);
  const days = clamp(positiveInteger(searchParams.get('days'), 7), 1, 90);
  const appliedFilters = useMemo(
    () => readFilters(searchParams),
    // The serialized query string is the stable source of truth for URL state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [urlState],
  );

  const [queryDraft, setQueryDraft] = useState(query);
  const [filterDraft, setFilterDraft] = useState<FilterState>(appliedFilters);
  const [overview, setOverview] = useState<KnowledgeOverviewResponse | null>(null);
  const [result, setResult] = useState<SearchDocumentsResponse | null>(null);
  const [governance, setGovernance] = useState<SearchGovernanceResponse | null>(null);
  const [pageSize, setPageSize] = useState(10);
  const [feedbackEnabled, setFeedbackEnabled] = useState(true);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [feedbackRating, setFeedbackRating] = useState<SearchFeedbackRating | null>(null);
  const [feedbackReason, setFeedbackReason] = useState<SearchFeedbackReason>('irrelevant');
  const [feedbackComment, setFeedbackComment] = useState('');
  const [feedbackDetailOpen, setFeedbackDetailOpen] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [loadingResults, setLoadingResults] = useState(false);
  const [loadingGovernance, setLoadingGovernance] = useState(false);
  const [governanceAllowed, setGovernanceAllowed] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const replaceParams = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      mutate(params);
      const next = params.toString();
      router.replace(next ? `${pathname}?${next}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const [overviewData, preferences] = await Promise.all([
        requestApi<KnowledgeOverviewResponse>(`${apiBase}/knowledge/overview`),
        requestApi<SearchPreferencesResponse>(`${apiBase}/search/preferences`),
      ]);
      setOverview(overviewData);
      setPageSize(preferences.pageSize);
      setFeedbackEnabled(preferences.feedbackEnabled);
    } catch (loadError) {
      setError(messageOf(loadError));
    } finally {
      setLoadingOverview(false);
      setPreferencesLoaded(true);
    }
  }, [apiBase]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    setQueryDraft(query);
    setFilterDraft(appliedFilters);
  }, [appliedFilters, query]);

  useEffect(() => {
    if (view !== 'results' || !query || !preferencesLoaded) {
      setLoadingResults(false);
      if (!query) setResult(null);
      return;
    }

    const controller = new AbortController();
    setLoadingResults(true);
    setError(null);
    void requestApi<SearchDocumentsResponse>(`${apiBase}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: query,
        page,
        limit: pageSize,
        ...(appliedFilters.spaceId ? { spaceId: appliedFilters.spaceId } : {}),
        ...(appliedFilters.folderId ? { folderId: appliedFilters.folderId } : {}),
        ...(appliedFilters.tagIds.length ? { tagIds: appliedFilters.tagIds } : {}),
      }),
      signal: controller.signal,
    })
      .then(setResult)
      .catch((searchError: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(searchError));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingResults(false);
      });
    return () => controller.abort();
  }, [apiBase, appliedFilters, page, pageSize, preferencesLoaded, query, view]);

  useEffect(() => {
    setFeedbackRating(null);
    setFeedbackReason('irrelevant');
    setFeedbackComment('');
    setFeedbackDetailOpen(false);
  }, [result?.queryEventId]);

  const loadGovernance = useCallback(async () => {
    setLoadingGovernance(true);
    setError(null);
    try {
      const data = await requestApi<SearchGovernanceResponse>(
        `${apiBase}/search/governance?days=${days}`,
      );
      setGovernance(data);
      setGovernanceAllowed(true);
    } catch (governanceError) {
      if (governanceError instanceof ApiError && governanceError.status === 403) {
        setGovernanceAllowed(false);
      } else {
        setError(messageOf(governanceError));
      }
    } finally {
      setLoadingGovernance(false);
    }
  }, [apiBase, days]);

  useEffect(() => {
    if (view === 'governance') void loadGovernance();
  }, [loadGovernance, view]);

  function submitSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextQuery = queryDraft.trim();
    if (!nextQuery) return;
    replaceParams((params) => {
      params.set('q', nextQuery);
      params.delete('view');
      params.delete('page');
    });
  }

  function applyFilters(): void {
    replaceParams((params) => {
      writeOptional(params, 'space', filterDraft.spaceId);
      writeOptional(params, 'folder', filterDraft.folderId);
      writeOptional(params, 'tags', filterDraft.tagIds.join(','));
      params.delete('page');
    });
  }

  function resetFilters(): void {
    setFilterDraft(emptyFilters);
    replaceParams((params) => {
      params.delete('space');
      params.delete('folder');
      params.delete('tags');
      params.delete('page');
    });
  }

  async function submitFeedback(rating: SearchFeedbackRating): Promise<void> {
    if (!result?.queryEventId) return;
    setFeedbackBusy(true);
    setError(null);
    try {
      await requestApi(`${apiBase}/search/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queryEventId: result.queryEventId,
          rating,
          ...(rating === 'unhelpful'
            ? { reason: feedbackReason, comment: feedbackComment.trim() || null }
            : {}),
        }),
      });
      setFeedbackRating(rating);
      setFeedbackDetailOpen(false);
    } catch (feedbackError) {
      setError(messageOf(feedbackError));
    } finally {
      setFeedbackBusy(false);
    }
  }

  const availableFolders = useMemo(
    () =>
      overview?.folders.filter(
        (folder) => !filterDraft.spaceId || folder.spaceId === filterDraft.spaceId,
      ) ?? [],
    [filterDraft.spaceId, overview?.folders],
  );
  const hasFilters = Boolean(
    appliedFilters.spaceId || appliedFilters.folderId || appliedFilters.tagIds.length,
  );
  const totalPages = result ? Math.max(1, Math.ceil(result.total / result.pageSize)) : 1;

  return (
    <>
      <header className="topbar search-topbar">
        <div>
          <span className="eyebrow">统一检索</span>
          <h1>全文搜索</h1>
        </div>
        <div className="search-view-tabs" role="tablist" aria-label="检索视图">
          <button
            aria-selected={view === 'results'}
            className={view === 'results' ? 'active' : ''}
            onClick={() => replaceParams((params) => params.delete('view'))}
            role="tab"
            type="button"
          >
            <FileSearch size={15} /> 搜索结果
          </button>
          {governanceAllowed ? (
            <button
              aria-selected={view === 'governance'}
              className={view === 'governance' ? 'active' : ''}
              onClick={() =>
                replaceParams((params) => {
                  params.set('view', 'governance');
                  params.delete('page');
                })
              }
              role="tab"
              type="button"
            >
              <BarChart3 size={15} /> 检索治理
            </button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button
            onClick={() => (view === 'governance' ? void loadGovernance() : void loadOverview())}
            type="button"
          >
            <RefreshCw size={14} /> 重试
          </button>
        </div>
      ) : null}

      {view === 'results' ? (
        <>
          <form className="search-query-form" onSubmit={submitSearch}>
            <Search aria-hidden="true" size={19} />
            <input
              aria-label="搜索知识库"
              autoFocus
              maxLength={2000}
              onChange={(event) => setQueryDraft(event.target.value)}
              placeholder="搜索标题、正文、页码或表格内容"
              value={queryDraft}
            />
            {queryDraft ? (
              <button
                aria-label="清空搜索词"
                className="search-clear"
                onClick={() => setQueryDraft('')}
                title="清空"
                type="button"
              >
                <X size={16} />
              </button>
            ) : null}
            <Button disabled={!queryDraft.trim() || loadingResults} type="submit">
              {loadingResults ? (
                <LoaderCircle className="spinning" size={15} />
              ) : (
                <Search size={15} />
              )}
              搜索
            </Button>
          </form>

          <div className="search-workspace">
            <SearchFilters
              availableFolders={availableFolders}
              facets={result?.facets ?? null}
              filters={filterDraft}
              loading={loadingOverview}
              onApply={applyFilters}
              onChange={setFilterDraft}
              onReset={resetFilters}
              overview={overview}
            />
            <section className="search-results-pane" aria-busy={loadingResults}>
              {!query ? (
                <SearchEmpty
                  icon={<FileSearch size={24} />}
                  title="开始检索知识库"
                  detail="输入关键词后，可按空间、文件夹和标签缩小结果范围。"
                />
              ) : loadingResults && !result ? (
                <SearchEmpty
                  icon={<LoaderCircle className="spinning" size={23} />}
                  title="正在检索"
                  detail="正在合并关键词与语义相关结果。"
                />
              ) : result ? (
                <>
                  <div className="search-results-heading">
                    <div>
                      <strong>{result.total} 条结果</strong>
                      <span>
                        “{result.query}” · {result.durationMs} ms
                        {hasFilters ? ' · 已应用筛选' : ''}
                      </span>
                    </div>
                    <div className="search-heading-actions">
                      {feedbackEnabled && result.queryEventId ? (
                        <div className="search-feedback-actions" aria-label="搜索结果反馈">
                          <span>{feedbackRating ? '反馈已记录' : '结果有用吗'}</span>
                          <button
                            aria-label="结果有用"
                            aria-pressed={feedbackRating === 'helpful'}
                            className={feedbackRating === 'helpful' ? 'active' : ''}
                            disabled={feedbackBusy}
                            onClick={() => void submitFeedback('helpful')}
                            title="结果有用"
                            type="button"
                          >
                            <ThumbsUp size={15} />
                          </button>
                          <button
                            aria-label="结果无用"
                            aria-pressed={feedbackRating === 'unhelpful'}
                            className={feedbackRating === 'unhelpful' ? 'active' : ''}
                            disabled={feedbackBusy}
                            onClick={() => setFeedbackDetailOpen(true)}
                            title="结果无用"
                            type="button"
                          >
                            <ThumbsDown size={15} />
                          </button>
                        </div>
                      ) : null}
                      {loadingResults ? <LoaderCircle className="spinning" size={17} /> : null}
                    </div>
                  </div>
                  {feedbackDetailOpen && result.queryEventId ? (
                    <div className="search-feedback-detail">
                      <label>
                        <span>主要原因</span>
                        <select
                          onChange={(event) =>
                            setFeedbackReason(event.target.value as SearchFeedbackReason)
                          }
                          value={feedbackReason}
                        >
                          <option value="irrelevant">结果不相关</option>
                          <option value="incomplete">信息不完整</option>
                          <option value="outdated">内容已过时</option>
                          <option value="incorrect">内容不正确</option>
                          <option value="other">其他</option>
                        </select>
                      </label>
                      <label>
                        <span>补充说明</span>
                        <input
                          maxLength={1000}
                          onChange={(event) => setFeedbackComment(event.target.value)}
                          placeholder="可选"
                          value={feedbackComment}
                        />
                      </label>
                      <Button
                        disabled={feedbackBusy}
                        onClick={() => void submitFeedback('unhelpful')}
                      >
                        {feedbackBusy ? <LoaderCircle className="spinning" size={15} /> : null}
                        提交反馈
                      </Button>
                      <button
                        className="search-feedback-cancel"
                        disabled={feedbackBusy}
                        onClick={() => setFeedbackDetailOpen(false)}
                        type="button"
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                  {result.hits.length ? (
                    <ol className="search-result-list">
                      {result.hits.map((hit) => (
                        <SearchResult hit={hit} key={hit.chunkId} query={query} />
                      ))}
                    </ol>
                  ) : (
                    <SearchEmpty
                      icon={<FileText size={22} />}
                      title="没有匹配结果"
                      detail="尝试减少筛选条件，或改用更短、更明确的关键词。"
                    />
                  )}
                  {result.total > result.pageSize ? (
                    <SearchPagination
                      current={result.page}
                      onChange={(nextPage) =>
                        replaceParams((params) =>
                          nextPage === 1
                            ? params.delete('page')
                            : params.set('page', String(nextPage)),
                        )
                      }
                      total={totalPages}
                    />
                  ) : null}
                </>
              ) : null}
            </section>
          </div>
        </>
      ) : governanceAllowed ? (
        <GovernanceView
          data={governance}
          days={days}
          loading={loadingGovernance}
          onDaysChange={(nextDays) =>
            replaceParams((params) => params.set('days', String(nextDays)))
          }
        />
      ) : (
        <SearchEmpty
          icon={<BarChart3 size={23} />}
          title="无权访问检索治理"
          detail="该视图仅向知识管理员和访问控制管理员开放。"
        />
      )}
    </>
  );
}

function SearchFilters({
  availableFolders,
  facets,
  filters,
  loading,
  onApply,
  onChange,
  onReset,
  overview,
}: {
  availableFolders: KnowledgeFolder[];
  facets: SearchDocumentsResponse['facets'] | null;
  filters: FilterState;
  loading: boolean;
  onApply: () => void;
  onChange: (filters: FilterState) => void;
  onReset: () => void;
  overview: KnowledgeOverviewResponse | null;
}): ReactElement {
  const spaceCounts = facetMap(facets?.spaces ?? []);
  const folderCounts = facetMap(facets?.folders ?? []);
  const tagCounts = facetMap(facets?.tags ?? []);

  return (
    <aside className="search-filter-pane">
      <div className="search-filter-heading">
        <strong>
          <Filter size={15} /> 结果筛选
        </strong>
        <button onClick={onReset} type="button">
          重置
        </button>
      </div>
      <label className="search-field">
        <span>知识空间</span>
        <select
          disabled={loading}
          onChange={(event) => onChange({ ...filters, spaceId: event.target.value, folderId: '' })}
          value={filters.spaceId}
        >
          <option value="">全部空间</option>
          {overview?.spaces.map((space) => (
            <FacetOption count={spaceCounts.get(space.id)} item={space} key={space.id} />
          ))}
        </select>
      </label>
      <label className="search-field">
        <span>文件夹</span>
        <select
          disabled={loading}
          onChange={(event) => onChange({ ...filters, folderId: event.target.value })}
          value={filters.folderId}
        >
          <option value="">全部文件夹</option>
          {availableFolders.map((folder) => (
            <FacetOption count={folderCounts.get(folder.id)} item={folder} key={folder.id} />
          ))}
        </select>
      </label>
      <fieldset className="search-tag-filter">
        <legend>
          <Tags size={14} /> 标签
        </legend>
        {overview?.tags.length ? (
          overview.tags.map((tag) => (
            <label key={tag.id}>
              <input
                checked={filters.tagIds.includes(tag.id)}
                onChange={(event) =>
                  onChange({
                    ...filters,
                    tagIds: toggleValue(filters.tagIds, tag.id, event.target.checked),
                  })
                }
                type="checkbox"
              />
              <i style={{ backgroundColor: tag.color }} />
              <span>{tag.name}</span>
              <small>{tagCounts.get(tag.id) ?? 0}</small>
            </label>
          ))
        ) : (
          <p>{loading ? '正在载入筛选项' : '暂无标签'}</p>
        )}
      </fieldset>
      <Button className="search-filter-apply" onClick={onApply}>
        应用筛选
      </Button>
    </aside>
  );
}

function FacetOption({
  count,
  item,
}: {
  count: number | undefined;
  item: KnowledgeSpace | KnowledgeFolder;
}): ReactElement {
  return (
    <option value={item.id}>
      {item.name} ({count ?? 0})
    </option>
  );
}

function SearchResult({ hit, query }: { hit: SearchDocumentHit; query: string }): ReactElement {
  return (
    <li>
      <div className="search-result-title">
        <FileText size={17} />
        <strong>{highlight(hit.title, query)}</strong>
        <span>{Math.round(hit.score * 100)}%</span>
      </div>
      <p>{highlight(snippet(hit.content), query)}</p>
      <div className="search-result-meta">
        <span>
          <Folder size={13} /> {sourceLabel(hit)}
        </span>
        <code>{hit.documentId.slice(0, 8)}</code>
      </div>
    </li>
  );
}

function SearchPagination({
  current,
  onChange,
  total,
}: {
  current: number;
  onChange: (page: number) => void;
  total: number;
}): ReactElement {
  return (
    <nav className="search-pagination" aria-label="搜索结果分页">
      <button
        aria-label="上一页"
        disabled={current <= 1}
        onClick={() => onChange(current - 1)}
        title="上一页"
        type="button"
      >
        <ArrowLeft size={16} />
      </button>
      <span>
        第 {current} / {total} 页
      </span>
      <button
        aria-label="下一页"
        disabled={current >= total}
        onClick={() => onChange(current + 1)}
        title="下一页"
        type="button"
      >
        <ArrowRight size={16} />
      </button>
    </nav>
  );
}

function GovernanceView({
  data,
  days,
  loading,
  onDaysChange,
}: {
  data: SearchGovernanceResponse | null;
  days: number;
  loading: boolean;
  onDaysChange: (days: number) => void;
}): ReactElement {
  if (loading && !data) {
    return (
      <SearchEmpty
        icon={<LoaderCircle className="spinning" size={23} />}
        title="正在汇总检索指标"
        detail="统计查询量、零结果率与响应耗时。"
      />
    );
  }
  if (!data) return <SearchEmpty icon={<BarChart3 size={23} />} title="暂无治理数据" detail="" />;

  return (
    <section className="governance-view">
      <div className="governance-toolbar">
        <div>
          <strong>检索运行概览</strong>
          <span>包括独立搜索与知识问答触发的检索</span>
        </div>
        <label>
          <CalendarDays size={15} />
          <select
            aria-label="治理统计时间范围"
            onChange={(event) => onDaysChange(Number(event.target.value))}
            value={days}
          >
            <option value={7}>近 7 天</option>
            <option value={30}>近 30 天</option>
            <option value={90}>近 90 天</option>
          </select>
        </label>
      </div>
      <div className="governance-metrics">
        <Metric
          label="总查询"
          value={data.totalQueries}
          detail={`搜索 ${data.directSearchQueries} · 问答 ${data.answerQueries}`}
        />
        <Metric
          label="零结果率"
          value={formatPercent(data.zeroResultRate)}
          detail={`${data.zeroResultQueries} 次无结果`}
        />
        <Metric
          label="平均耗时"
          value={`${Math.round(data.averageDurationMs)} ms`}
          detail={`P95 ${Math.round(data.p95DurationMs)} ms`}
        />
        <Metric
          label="平均结果数"
          value={formatDecimal(data.averageResultCount)}
          detail={`${data.failedQueries} 次失败`}
        />
      </div>
      <div className="governance-grid">
        <QueryTable items={data.topQueries} title="高频查询" />
        <QueryTable items={data.noResultQueries} title="零结果查询" />
      </div>
      <div className="governance-recent">
        <div className="governance-section-heading">
          <strong>最近查询</strong>
          <span>{data.recentQueries.length} 条</span>
        </div>
        <div className="governance-table-scroll">
          <table>
            <thead>
              <tr>
                <th>查询</th>
                <th>来源</th>
                <th>结果</th>
                <th>耗时</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {data.recentQueries.length ? (
                data.recentQueries.map((item) => (
                  <tr key={item.id}>
                    <td>{item.query}</td>
                    <td>{item.source === 'search' ? '全文搜索' : '知识问答'}</td>
                    <td>{item.status === 'failed' ? '失败' : item.resultCount}</td>
                    <td>{item.durationMs} ms</td>
                    <td>{formatDate(item.createdAt)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="governance-empty-cell" colSpan={5}>
                    暂无查询记录
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Metric({
  detail,
  label,
  value,
}: {
  detail: string;
  label: string;
  value: ReactNode;
}): ReactElement {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function QueryTable({
  items,
  title,
}: {
  items: SearchGovernanceQueryItem[];
  title: string;
}): ReactElement {
  return (
    <section className="governance-query-table">
      <div className="governance-section-heading">
        <strong>{title}</strong>
        <span>{items.length} 项</span>
      </div>
      {items.length ? (
        <ol>
          {items.map((item) => (
            <li key={item.query}>
              <span title={item.query}>{item.query}</span>
              <strong>{item.count}</strong>
              <small>{Math.round(item.averageDurationMs)} ms</small>
            </li>
          ))}
        </ol>
      ) : (
        <p>暂无数据</p>
      )}
    </section>
  );
}

function SearchEmpty({
  detail,
  icon,
  title,
}: {
  detail: string;
  icon: ReactNode;
  title: string;
}): ReactElement {
  return (
    <div className="search-empty">
      {icon}
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

export function SearchWorkspaceFallback(): ReactElement {
  return (
    <div className="search-page-loading" role="status">
      <LoaderCircle className="spinning" size={21} /> 正在载入全文搜索
    </div>
  );
}

function readFilters(params: URLSearchParams): FilterState {
  return {
    spaceId: params.get('space') ?? '',
    folderId: params.get('folder') ?? '',
    tagIds: (params.get('tags') ?? '').split(',').filter(Boolean),
  };
}

function facetMap(values: SearchFacetValue[]): Map<string, number> {
  return new Map(values.map((item) => [item.id, item.count]));
}

function toggleValue(values: string[], value: string, included: boolean): string[] {
  return included ? [...new Set([...values, value])] : values.filter((item) => item !== value);
}

function writeOptional(params: URLSearchParams, key: string, value: string): void {
  if (value) params.set(key, value);
  else params.delete(key);
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snippet(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return normalized.length > 420 ? `${normalized.slice(0, 417)}...` : normalized;
}

function highlight(value: string, query: string): ReactNode {
  const terms = [
    ...new Set(
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((term) => term.length > 1),
    ),
  ]
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
  if (!terms.length) return value;
  const expression = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  return value
    .split(expression)
    .map((part, index) =>
      terms.includes(part.toLowerCase()) ? (
        <mark key={`${part}-${index}`}>{part}</mark>
      ) : (
        <Fragment key={`${part}-${index}`}>{part}</Fragment>
      ),
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sourceLabel(hit: SearchDocumentHit): string {
  const source = hit.source;
  if (source.type === 'page' && source.page) return `第 ${source.page} 页`;
  if (source.type === 'slide' && source.slide) return `第 ${source.slide} 张幻灯片`;
  if (source.type === 'sheet' && source.sheet) {
    const rows = source.rowStart
      ? ` · 第 ${source.rowStart}${source.rowEnd && source.rowEnd !== source.rowStart ? `-${source.rowEnd}` : ''} 行`
      : '';
    return `${source.sheet}${rows}`;
  }
  if (source.heading) return source.heading;
  return '文档正文';
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0 && value < 0.01 ? 1 : 0)}%`;
}

function formatDecimal(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
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
