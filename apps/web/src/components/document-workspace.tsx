'use client';

import {
  ArrowUpRight,
  Ban,
  Check,
  CheckCircle2,
  Clipboard,
  Clock3,
  FileText,
  FileUp,
  History,
  LoaderCircle,
  MessageSquareText,
  MessageSquarePlus,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from 'react';
import { Button } from '@knowledge-base/ui/button';
import {
  formatFileSize,
  sha256Hex,
  titleFromFilename,
  validateDocumentFile,
} from '@/lib/document-upload';

const defaultTenantId = '11111111-1111-4111-8111-111111111111';

type DocumentRecord = {
  id: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  currentReadyVersionId: string | null;
  createdAt: string;
};

type DocumentVersion = {
  id: string;
  versionNo: number;
  sourceFilename: string;
  ingestionStatus: string;
};

type UploadResponse = {
  documentId: string;
  documentVersionId: string;
  uploadUrl: string;
  uploadHeaders: Record<string, string>;
};

type CompleteResponse = {
  documentId: string;
  documentVersionId: string;
  jobId: string;
  status: 'queued' | 'ready';
};

type IngestionJob = {
  status: 'queued' | 'active' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  errorMessage: string | null;
};

type AnswerCitation = {
  ordinal: number;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  title: string;
  excerpt: string;
  source: {
    page: number | null;
    slide: number | null;
    sheet: string | null;
    heading: string | null;
  };
};

type AnswerResponse = {
  conversationId: string;
  messageId: string;
  answer: string;
  grounded: boolean;
  model: string;
  citations: AnswerCitation[];
};

type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

type ConversationDetail = ConversationSummary & {
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    model: string | null;
    createdAt: string;
    citations: AnswerCitation[];
  }>;
};

type FlowPhase =
  'idle' | 'hashing' | 'uploading' | 'confirming' | 'processing' | 'ready' | 'failed' | 'cancelled';

type FlowState = {
  phase: FlowPhase;
  progress: number;
  filename: string | null;
  message: string;
  jobId?: string;
  documentId?: string;
  documentVersionId?: string;
};

const initialFlow: FlowState = {
  phase: 'idle',
  progress: 0,
  filename: null,
  message: '暂无处理任务',
};

const phaseLabels: Record<FlowPhase, string> = {
  idle: '空闲',
  hashing: '校验文件',
  uploading: '上传源文件',
  confirming: '确认入库',
  processing: '解析文档',
  ready: '处理完成',
  failed: '处理失败',
  cancelled: '已取消',
};

export function DocumentWorkspace(): ReactElement {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api';
  const tenantId = process.env.NEXT_PUBLIC_DEMO_TENANT_ID ?? defaultTenantId;
  const inputRef = useRef<HTMLInputElement>(null);
  const answerAbortRef = useRef<AbortController | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<DocumentVersion | null>(null);
  const [markdown, setMarkdown] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [loadingDocuments, setLoadingDocuments] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [flow, setFlow] = useState<FlowState>(initialFlow);
  const [copied, setCopied] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [activeQuestion, setActiveQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [answerModel, setAnswerModel] = useState<string | null>(null);
  const [answerGrounded, setAnswerGrounded] = useState(false);
  const [answerCitations, setAnswerCitations] = useState<AnswerCitation[]>([]);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationBusy, setConversationBusy] = useState(false);

  const loadDocument = useCallback(
    async (documentId: string): Promise<void> => {
      setSelectedDocumentId(documentId);
      setLoadingPreview(true);
      setPageError(null);
      try {
        const detail = await requestApi<{
          document: DocumentRecord;
          versions: DocumentVersion[];
        }>(`${apiBase}/documents/${documentId}?tenantId=${tenantId}`);
        const version =
          detail.versions.find((item) => item.id === detail.document.currentReadyVersionId) ??
          detail.versions.find((item) => item.ingestionStatus === 'ready') ??
          null;
        setSelectedVersion(version);
        if (!version) {
          setMarkdown('');
          return;
        }
        const response = await fetch(
          `${apiBase}/documents/${documentId}/versions/${version.id}/markdown?tenantId=${tenantId}`,
        );
        if (!response.ok) throw new Error('Markdown 内容读取失败');
        setMarkdown(await response.text());
      } catch (error) {
        setMarkdown('');
        setSelectedVersion(null);
        setPageError(errorMessage(error));
      } finally {
        setLoadingPreview(false);
      }
    },
    [apiBase, tenantId],
  );

  const refreshDocuments = useCallback(
    async (focusDocumentId?: string): Promise<void> => {
      setLoadingDocuments(true);
      try {
        const result = await requestApi<{
          items: DocumentRecord[];
          total: number;
          page: number;
          pageSize: number;
        }>(`${apiBase}/documents?tenantId=${tenantId}&page=1&pageSize=50`);
        setDocuments(result.items);
        const target =
          focusDocumentId ?? result.items.find((item) => item.currentReadyVersionId)?.id ?? null;
        if (target) await loadDocument(target);
      } catch (error) {
        setPageError(errorMessage(error));
      } finally {
        setLoadingDocuments(false);
      }
    },
    [apiBase, loadDocument, tenantId],
  );

  useEffect(() => {
    void refreshDocuments();
  }, [refreshDocuments]);

  const refreshConversations = useCallback(async (): Promise<void> => {
    try {
      const result = await requestApi<{
        items: ConversationSummary[];
        total: number;
        page: number;
        pageSize: number;
      }>(`${apiBase}/answers/conversations?page=1&pageSize=30`);
      setConversations(result.items);
    } catch (error) {
      setAnswerError(errorMessage(error));
    }
  }, [apiBase]);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  const readyCount = useMemo(
    () => documents.filter((document) => document.currentReadyVersionId).length,
    [documents],
  );
  const hasActiveFlow = ['hashing', 'uploading', 'confirming', 'processing'].includes(flow.phase);

  function openUpload(): void {
    setFormError(null);
    setDialogOpen(true);
  }

  function closeUpload(): void {
    if (submitting) return;
    setDialogOpen(false);
    setFile(null);
    setTitle('');
    setFormError(null);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    setFormError(nextFile ? validateDocumentFile(nextFile) : null);
    if (nextFile) setTitle(titleFromFilename(nextFile.name));
  }

  async function submitUpload(): Promise<void> {
    if (!file) {
      setFormError('请选择文件');
      return;
    }
    const validationError = validateDocumentFile(file);
    if (validationError) {
      setFormError(validationError);
      return;
    }
    if (!title.trim()) {
      setFormError('请输入文档标题');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setPageError(null);
    setFlow({ phase: 'hashing', progress: 8, filename: file.name, message: '正在计算 SHA-256' });

    try {
      const sha256 = await sha256Hex(file);
      const created = await requestApi<UploadResponse>(`${apiBase}/documents/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          title: title.trim(),
          sourceFilename: file.name,
          mimeType: mimeTypeFor(file),
          sizeBytes: file.size,
          sha256,
        }),
      });

      setDialogOpen(false);
      setFlow({ phase: 'uploading', progress: 28, filename: file.name, message: '正在写入 MinIO' });
      const uploadResponse = await fetch(created.uploadUrl, {
        method: 'PUT',
        headers: created.uploadHeaders,
        body: file,
      });
      if (!uploadResponse.ok) throw new Error(`源文件上传失败（${uploadResponse.status}）`);

      setFlow({ phase: 'confirming', progress: 42, filename: file.name, message: '正在确认对象' });
      const completed = await requestApi<CompleteResponse>(
        `${apiBase}/documents/${created.documentId}/versions/${created.documentVersionId}/complete`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId }),
        },
      );

      if (completed.status !== 'ready') {
        setFlow({
          phase: 'processing',
          progress: 48,
          filename: file.name,
          message: '等待 Worker',
          jobId: completed.jobId,
          documentId: created.documentId,
          documentVersionId: created.documentVersionId,
        });
        await waitForJob(apiBase, tenantId, completed.jobId, (job) => {
          setFlow((current) => ({
            ...current,
            phase: 'processing',
            progress: Math.max(48, job.progress),
            message: job.status === 'queued' ? '等待 Worker' : '正在生成规范化 Markdown',
          }));
        });
      }

      setFlow((current) => ({
        ...current,
        phase: 'ready',
        progress: 100,
        filename: file.name,
        message: 'Markdown 已就绪',
        documentId: created.documentId,
        documentVersionId: created.documentVersionId,
      }));
      setFile(null);
      setTitle('');
      if (inputRef.current) inputRef.current.value = '';
      await refreshDocuments(created.documentId);
    } catch (error) {
      if (error instanceof JobCancelledError) {
        setFlow((current) => ({ ...current, phase: 'cancelled', message: error.message }));
        return;
      }
      const message = errorMessage(error);
      setFlow((current) => ({ ...current, phase: 'failed', message }));
      setPageError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelCurrentJob(): Promise<void> {
    if (!flow.jobId || actionBusy) return;
    setActionBusy(true);
    try {
      await requestApi(`${apiBase}/ingestion/jobs/${flow.jobId}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      setFlow((current) => ({
        ...current,
        phase: 'cancelled',
        message: '任务已取消，已生成的临时对象将由清理任务处理',
      }));
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function retryCurrentJob(): Promise<void> {
    if (!flow.jobId || actionBusy) return;
    setActionBusy(true);
    setPageError(null);
    try {
      await requestApi(`${apiBase}/ingestion/jobs/${flow.jobId}/retry`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tenantId }),
      });
      setFlow((current) => ({
        ...current,
        phase: 'processing',
        progress: 0,
        message: '重试任务已提交',
      }));
      await waitForJob(apiBase, tenantId, flow.jobId, (job) => {
        setFlow((current) => ({
          ...current,
          phase: 'processing',
          progress: job.progress,
          message: job.status === 'queued' ? '等待 Worker' : '正在重新处理',
        }));
      });
      setFlow((current) => ({
        ...current,
        phase: 'ready',
        progress: 100,
        message: '重试完成，Markdown 已就绪',
      }));
      await refreshDocuments(flow.documentId);
    } catch (error) {
      const message = errorMessage(error);
      setFlow((current) => ({ ...current, phase: 'failed', message }));
      setPageError(message);
    } finally {
      setActionBusy(false);
    }
  }

  async function publishSelectedVersion(): Promise<void> {
    if (!selectedDocumentId || !selectedVersion || actionBusy) return;
    setActionBusy(true);
    setPageError(null);
    try {
      await requestApi(
        `${apiBase}/documents/${selectedDocumentId}/versions/${selectedVersion.id}/publish`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId }),
        },
      );
      await refreshDocuments(selectedDocumentId);
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function deleteSelectedDocument(): Promise<void> {
    if (!selectedDocumentId || actionBusy) return;
    if (!window.confirm('确定删除该文档及其所有版本吗？')) return;
    setActionBusy(true);
    setPageError(null);
    try {
      await requestApi(`${apiBase}/documents/${selectedDocumentId}?tenantId=${tenantId}`, {
        method: 'DELETE',
      });
      setSelectedDocumentId(null);
      setSelectedVersion(null);
      setMarkdown('');
      await refreshDocuments();
    } catch (error) {
      setPageError(errorMessage(error));
    } finally {
      setActionBusy(false);
    }
  }

  async function copyMarkdown(): Promise<void> {
    if (!markdown) return;
    await navigator.clipboard.writeText(markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function askQuestion(): Promise<void> {
    const nextQuestion = question.trim();
    if (!nextQuestion || answering) return;
    setAnswering(true);
    setActiveQuestion(nextQuestion);
    setAnswer('');
    setAnswerModel(null);
    setAnswerGrounded(false);
    setAnswerCitations([]);
    setAnswerError(null);
    const abortController = new AbortController();
    answerAbortRef.current = abortController;

    try {
      const response = await fetch(`${apiBase}/answers/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationId ?? undefined,
          question: nextQuestion,
          limit: 6,
        }),
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`问答请求失败（${response.status}）`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;
      const consume = (frame: string): void => {
        const eventName = frame.match(/^event:\s*(.+)$/mu)?.[1]?.trim() ?? 'message';
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) return;
        const payload = JSON.parse(data) as
          | ({ type: 'meta' } & Pick<
              AnswerResponse,
              'conversationId' | 'messageId' | 'model' | 'citations'
            >)
          | { type: 'token'; content: string }
          | { type: 'done'; response: AnswerResponse }
          | { message: string };
        if (eventName === 'error')
          throw new Error('message' in payload ? payload.message : '问答失败');
        if ('type' in payload && payload.type === 'meta') {
          setConversationId(payload.conversationId);
          setAnswerModel(payload.model);
          setAnswerCitations(payload.citations);
        } else if ('type' in payload && payload.type === 'token') {
          setAnswer((current) => current + payload.content);
        } else if ('type' in payload && payload.type === 'done') {
          completed = true;
          setConversationId(payload.response.conversationId);
          setAnswer(payload.response.answer);
          setAnswerModel(payload.response.model);
          setAnswerGrounded(payload.response.grounded);
          setAnswerCitations(payload.response.citations);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const frames = buffer.split(/\r?\n\r?\n/u);
        buffer = frames.pop() ?? '';
        frames.forEach(consume);
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
      if (!completed) throw new Error('问答流提前结束');
      setQuestion('');
      await refreshConversations();
    } catch (error) {
      setAnswerError(
        error instanceof Error && error.name === 'AbortError' ? '已停止生成' : errorMessage(error),
      );
    } finally {
      if (answerAbortRef.current === abortController) answerAbortRef.current = null;
      setAnswering(false);
    }
  }

  function cancelAnswer(): void {
    answerAbortRef.current?.abort();
  }

  function newConversation(): void {
    cancelAnswer();
    setConversationId(null);
    setActiveQuestion(null);
    setAnswer('');
    setAnswerModel(null);
    setAnswerGrounded(false);
    setAnswerCitations([]);
    setAnswerError(null);
    setQuestion('');
  }

  async function openConversation(nextConversationId: string): Promise<void> {
    if (!nextConversationId) {
      newConversation();
      return;
    }
    setConversationBusy(true);
    setAnswerError(null);
    try {
      const detail = await requestApi<ConversationDetail>(
        `${apiBase}/answers/conversations/${nextConversationId}`,
      );
      const userMessages = detail.messages.filter((message) => message.role === 'user');
      const assistantMessages = detail.messages.filter((message) => message.role === 'assistant');
      const latestUser = userMessages[userMessages.length - 1];
      const latestAssistant = assistantMessages[assistantMessages.length - 1];
      setConversationId(detail.id);
      setActiveQuestion(latestUser?.content ?? detail.title);
      setAnswer(latestAssistant?.content ?? '');
      setAnswerModel(latestAssistant?.model ?? null);
      setAnswerGrounded((latestAssistant?.citations.length ?? 0) > 0);
      setAnswerCitations(latestAssistant?.citations ?? []);
    } catch (error) {
      setAnswerError(errorMessage(error));
    } finally {
      setConversationBusy(false);
    }
  }

  async function deleteConversation(): Promise<void> {
    if (!conversationId || conversationBusy) return;
    if (!window.confirm('确定删除当前会话记录吗？')) return;
    setConversationBusy(true);
    try {
      await requestApi(`${apiBase}/answers/conversations/${conversationId}`, { method: 'DELETE' });
      newConversation();
      await refreshConversations();
    } catch (error) {
      setAnswerError(errorMessage(error));
    } finally {
      setConversationBusy(false);
    }
  }

  async function openCitation(citation: AnswerCitation): Promise<void> {
    await loadDocument(citation.documentId);
    document.getElementById('preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <section className="content" id="workspace">
      <header className="topbar">
        <div>
          <p className="eyebrow">知识运营</p>
          <h1>工作台</h1>
        </div>
        <Button onClick={openUpload}>
          <FileUp size={16} /> 上传文档
        </Button>
      </header>

      <section className="metrics" aria-label="知识库状态">
        <div>
          <span>知识空间</span>
          <strong>01</strong>
          <small>企业公共知识库</small>
        </div>
        <div>
          <span>文档总数</span>
          <strong>{String(documents.length).padStart(2, '0')}</strong>
          <small>{loadingDocuments ? '正在同步' : 'PostgreSQL'}</small>
        </div>
        <div>
          <span>已就绪文档</span>
          <strong>{String(readyCount).padStart(2, '0')}</strong>
          <small>Markdown 可读取</small>
        </div>
        <div>
          <span>当前任务</span>
          <strong>{hasActiveFlow ? '01' : '00'}</strong>
          <small>Redis / BullMQ</small>
        </div>
      </section>

      {pageError ? (
        <div className="notice error-notice" role="alert">
          <span>{pageError}</span>
          <button type="button" onClick={() => void refreshDocuments()}>
            <RefreshCw size={15} /> 重试
          </button>
        </div>
      ) : null}

      <section className="panel answer-panel" id="assistant">
        <div className="panel-heading">
          <div>
            <h2>知识问答</h2>
            <p>
              {answerModel
                ? `${answerModel} · ${answerGrounded ? '已引用证据' : '无可用证据'}`
                : '检索已就绪文档'}
            </p>
          </div>
          {answering ? (
            <LoaderCircle className="state-icon spinning" size={22} />
          ) : (
            <MessageSquareText className="state-icon" size={22} />
          )}
        </div>

        <div className="conversation-toolbar">
          <label className="conversation-select">
            <History size={15} />
            <select
              aria-label="最近会话"
              disabled={answering || conversationBusy}
              onChange={(event) => void openConversation(event.target.value)}
              value={conversationId ?? ''}
            >
              <option value="">新对话</option>
              {conversations.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.title}
                </option>
              ))}
            </select>
          </label>
          <button
            aria-label="新建会话"
            className="icon-button"
            disabled={answering}
            onClick={newConversation}
            title="新建会话"
            type="button"
          >
            <MessageSquarePlus size={17} />
          </button>
          <button
            aria-label="删除会话"
            className="icon-button danger"
            disabled={!conversationId || answering || conversationBusy}
            onClick={() => void deleteConversation()}
            title="删除会话"
            type="button"
          >
            <Trash2 size={17} />
          </button>
        </div>

        <form
          className="question-form"
          onSubmit={(event) => {
            event.preventDefault();
            void askQuestion();
          }}
        >
          <textarea
            aria-label="知识库问题"
            maxLength={4000}
            disabled={answering}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void askQuestion();
              }
            }}
            placeholder="输入要查询的问题"
            rows={2}
            value={question}
          />
          {answering ? (
            <Button aria-label="停止生成" onClick={cancelAnswer} type="button" variant="secondary">
              <Square size={14} /> 停止
            </Button>
          ) : (
            <Button aria-label="发送问题" disabled={!question.trim()} type="submit">
              <Send size={16} /> 发送
            </Button>
          )}
        </form>

        <div className="answer-layout" aria-live="polite">
          <div className="answer-content">
            {activeQuestion ? <p className="active-question">{activeQuestion}</p> : null}
            {answer ? (
              <div className="answer-text">{answer}</div>
            ) : (
              <span className="answer-placeholder">尚未提问</span>
            )}
            {answerError ? <p className="answer-error">{answerError}</p> : null}
          </div>
          <aside className="citation-list" aria-label="回答证据">
            <strong>证据 {answerCitations.length > 0 ? answerCitations.length : ''}</strong>
            {answerCitations.map((citation) => (
              <button
                key={citation.chunkId}
                onClick={() => void openCitation(citation)}
                type="button"
              >
                <span>
                  [{citation.ordinal}] {citation.title}
                </span>
                <small>{citationSource(citation)}</small>
                <p>{citation.excerpt}</p>
                <ArrowUpRight size={15} />
              </button>
            ))}
            {!answering && answerCitations.length === 0 ? <span>暂无引用</span> : null}
          </aside>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel document-panel" id="documents">
          <div className="panel-heading">
            <div>
              <h2>文档处理</h2>
              <p>最近创建的文档与当前版本</p>
            </div>
            <Button variant="secondary" onClick={openUpload}>
              <FileUp size={15} /> 新建
            </Button>
          </div>
          <div className="document-table">
            <div className="document-row document-head">
              <span>文档</span>
              <span>状态</span>
              <span>创建时间</span>
            </div>
            {documents.map((document) => (
              <button
                className={`document-row document-item ${selectedDocumentId === document.id ? 'selected' : ''}`}
                key={document.id}
                type="button"
                onClick={() => void loadDocument(document.id)}
              >
                <span className="document-name">
                  <FileText size={17} />
                  <b>{document.title}</b>
                </span>
                <span className="document-status">
                  <i className={`dot ${document.currentReadyVersionId ? 'ready' : 'queued'}`} />
                  {document.status === 'published'
                    ? '已发布'
                    : document.currentReadyVersionId
                      ? '已就绪'
                      : '待处理'}
                </span>
                <time dateTime={document.createdAt}>{formatDate(document.createdAt)}</time>
              </button>
            ))}
            {!loadingDocuments && documents.length === 0 ? (
              <div className="table-empty">暂无文档</div>
            ) : null}
            {loadingDocuments ? <div className="table-empty">正在加载文档</div> : null}
          </div>
        </div>

        <aside className="panel progress-panel" aria-live="polite">
          <div className="panel-heading">
            <div>
              <h2>当前处理</h2>
              <p>{flow.filename ?? '队列处于空闲状态'}</p>
            </div>
            {flow.phase === 'ready' ? (
              <CheckCircle2 className="state-icon ready" size={22} />
            ) : hasActiveFlow ? (
              <LoaderCircle className="state-icon spinning" size={22} />
            ) : (
              <Clock3 className="state-icon" size={22} />
            )}
          </div>
          <div className="progress-summary">
            <strong>{phaseLabels[flow.phase]}</strong>
            <span>{flow.progress}%</span>
          </div>
          <div
            className="progress-track"
            aria-label="处理进度"
            aria-valuenow={flow.progress}
            role="progressbar"
          >
            <span style={{ width: `${flow.progress}%` }} />
          </div>
          <p className={`flow-message ${flow.phase === 'failed' ? 'failed' : ''}`}>
            {flow.message}
          </p>
          <ol className="stage-list">
            {[
              ['校验', 8],
              ['上传', 28],
              ['解析', 48],
              ['就绪', 100],
            ].map(([label, threshold]) => (
              <li className={flow.progress >= Number(threshold) ? 'complete' : ''} key={label}>
                <span>{flow.progress >= Number(threshold) ? <Check size={12} /> : null}</span>
                {label}
              </li>
            ))}
          </ol>
          {hasActiveFlow && flow.jobId ? (
            <Button
              variant="secondary"
              className="retry-upload"
              disabled={actionBusy}
              onClick={() => void cancelCurrentJob()}
            >
              <Ban size={15} /> 取消任务
            </Button>
          ) : null}
          {flow.phase === 'failed' ? (
            <div className="flow-actions">
              {flow.jobId ? (
                <Button
                  variant="secondary"
                  disabled={actionBusy}
                  onClick={() => void retryCurrentJob()}
                >
                  <RotateCcw size={15} /> 重试任务
                </Button>
              ) : null}
              <Button variant="secondary" onClick={openUpload}>
                <RefreshCw size={15} /> 重新上传
              </Button>
            </div>
          ) : null}
          {flow.phase === 'cancelled' ? (
            <Button variant="secondary" className="retry-upload" onClick={openUpload}>
              <RefreshCw size={15} /> 重新上传
            </Button>
          ) : null}
        </aside>
      </section>

      <section className="panel preview-panel" id="preview">
        <div className="panel-heading">
          <div>
            <h2>Markdown 预览</h2>
            <p>
              {selectedVersion
                ? `${selectedVersion.sourceFilename} · v${selectedVersion.versionNo}`
                : '选择已就绪文档'}
            </p>
          </div>
          <div className="preview-actions">
            {selectedVersion ? (
              <Button
                variant="secondary"
                disabled={actionBusy}
                onClick={() => void publishSelectedVersion()}
              >
                <Send size={15} /> 发布版本
              </Button>
            ) : null}
            <button
              aria-label="删除文档"
              className="icon-button danger"
              disabled={!selectedDocumentId || actionBusy}
              onClick={() => void deleteSelectedDocument()}
              title="删除文档"
              type="button"
            >
              <Trash2 size={17} />
            </button>
            <button
              aria-label="复制 Markdown"
              className="icon-button"
              disabled={!markdown}
              onClick={() => void copyMarkdown()}
              title="复制 Markdown"
              type="button"
            >
              {copied ? <Check size={17} /> : <Clipboard size={17} />}
            </button>
          </div>
        </div>
        <div className="markdown-preview">
          {loadingPreview ? (
            <span className="preview-placeholder">正在读取 Markdown</span>
          ) : markdown ? (
            <pre>{markdown}</pre>
          ) : (
            <span className="preview-placeholder">暂无可预览内容</span>
          )}
        </div>
      </section>

      {dialogOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={closeUpload}>
          <div
            aria-labelledby="upload-dialog-title"
            aria-modal="true"
            className="upload-dialog"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="dialog-heading">
              <div>
                <h2 id="upload-dialog-title">上传文档</h2>
                <p>TXT、Markdown、DOCX、PDF、XLSX 或 PPTX，最大 50 MB</p>
              </div>
              <button
                aria-label="关闭"
                className="icon-button"
                onClick={closeUpload}
                title="关闭"
                type="button"
              >
                <X size={18} />
              </button>
            </div>

            <input
              accept=".txt,.md,.markdown,.docx,.pdf,.xlsx,.pptx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
              className="visually-hidden"
              onChange={handleFileChange}
              ref={inputRef}
              type="file"
            />
            <button className="file-picker" onClick={() => inputRef.current?.click()} type="button">
              <UploadCloud size={24} />
              <span>{file ? file.name : '选择文件'}</span>
              <small>
                {file ? formatFileSize(file.size) : 'TXT / MD / DOCX / PDF / XLSX / PPTX'}
              </small>
            </button>

            <label className="field-label" htmlFor="document-title">
              文档标题
            </label>
            <input
              className="text-input"
              id="document-title"
              maxLength={500}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="输入文档标题"
              value={title}
            />
            {formError ? <p className="form-error">{formError}</p> : null}

            <div className="dialog-actions">
              <Button disabled={submitting} onClick={closeUpload} variant="secondary">
                取消
              </Button>
              <Button
                disabled={submitting || !file || !title.trim()}
                onClick={() => void submitUpload()}
              >
                {submitting ? (
                  <LoaderCircle className="spinning" size={16} />
                ) : (
                  <FileUp size={16} />
                )}
                {submitting ? '处理中' : '开始上传'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

async function waitForJob(
  apiBase: string,
  tenantId: string,
  jobId: string,
  onProgress: (job: IngestionJob) => void,
): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const job = await requestApi<IngestionJob>(
      `${apiBase}/ingestion/jobs/${jobId}?tenantId=${tenantId}`,
    );
    onProgress(job);
    if (job.status === 'completed') return;
    if (job.status === 'failed' || job.status === 'cancelled') {
      if (job.status === 'cancelled')
        throw new JobCancelledError(job.errorMessage ?? '文档处理已取消');
      throw new Error(job.errorMessage ?? '文档处理失败');
    }
    await delay(800);
  }
  throw new Error('文档处理超时，请稍后刷新');
}

class JobCancelledError extends Error {}

async function requestApi<T>(url: string, init?: RequestInit): Promise<T> {
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

function mimeTypeFor(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mimeTypes: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    md: 'text/markdown',
    markdown: 'text/markdown',
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return (mimeTypes[extension] ?? file.type) || 'application/octet-stream';
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '发生未知错误';
}

function citationSource(citation: AnswerCitation): string {
  if (citation.source.page) return `第 ${citation.source.page} 页`;
  if (citation.source.slide) return `第 ${citation.source.slide} 张幻灯片`;
  if (citation.source.sheet) return `工作表 ${citation.source.sheet}`;
  return citation.source.heading ?? '文档正文';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
