# Enterprise Knowledge Base

企业级知识库 monorepo。当前已经打通 TXT、Markdown、DOCX、PDF、XLSX 和 PPTX 文档链路：Web 创建文档版本并直传 MinIO，API 在同一事务中保存版本状态和 Outbox 事件，投递器可靠写入 BullMQ，Worker 解析和规范化 Markdown，按来源边界切片后同时写入 pgvector 和 Elasticsearch，最终通过带来源引用的 RAG 问答读取知识。

## Start

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

- Web: http://localhost:3002
- API health: http://localhost:4000/api/health
- MinIO console: http://localhost:9001
- Elasticsearch: http://localhost:9200

打开 Web 后可以上传 `.txt`、`.md`、`.markdown`、`.docx`、`.pdf`、`.xlsx` 或 `.pptx` 文件（最大 50 MB）。DOCX 保留标题、列表、表格和链接；PDF 生成页边界与页码锚点；XLSX 保留 Sheet、表格、公式缓存结果和合并单元格主值；PPTX 保留幻灯片标题、正文和表格。内嵌图片存入私有 `document_asset`，读取 Markdown 时才生成短期签名地址。工作台的知识问答按 SSE 流式输出，并可从引用直接跳到对应文档预览。

处理任务最多自动执行 3 次并使用指数退避。BullMQ jobId 由版本 ID 和任务代次组成；最终失败会写入死信时间，失败版本可通过 API 或 Web 原地重试。版本处理完成只会进入 `ready`，不会自动成为线上版本；只有具备审核权限的直接发布或审核批准会原子切换 `current_ready_version_id`。删除文档会先归档，再由独立队列清理 MinIO 对象、来源锚点和资产投影。

检索阶段使用 Elasticsearch 关键词召回和 pgvector 向量召回，以 RRF 融合并重排。重排后的候选会按内容哈希删除完全重复项；相邻且高度相似、来源一致的分片会合并；非相邻的高度相似分片只在来源一致时保留高分项，不同来源继续保留。最后使用 MMR 降低重复候选的优先级，不会由 MMR 直接删除候选。整个整理过程在本地复用已有分片向量，不会增加模型调用。`RAG_NEAR_DUPLICATE_THRESHOLD` 控制高度相似判定，默认 `0.92`；`RAG_MMR_LAMBDA` 控制相关性与多样性的权衡，默认 `0.7`。两个召回查询都会下推租户、有效主体和 `published` 状态过滤，最终只返回逻辑文档当前发布版本。待审新版本不会替换或隐藏旧发布版本。默认 `local-hash-v1`、`local-lexical-v1` 和 `local-extractive-v1` 是无需密钥、可重复验收的开发基线，不具备跨语言语义能力；生产环境应配置 `MODEL_PROVIDER=openai-compatible` 和真实 Embedding/Chat 模型，按需将 `RERANKER_PROVIDER` 切换为 HTTP 服务。

版本审核绑定不可变的 `document_version`。文档管理员可以提交或撤回待审版本；拥有 `documents.review` 的审核员可以查看租户待办、批准或驳回。批准会在同一 PostgreSQL 事务中结案审核、切换发布版本、记录审计并写入搜索投影 Outbox。

独立全文搜索页位于 `/search`，支持 URL 查询状态、空间/文件夹/标签 Facet、固定候选窗口分页、来源定位和命中高亮。知识管理员可在同页查看近 7/30/90 天查询量、零结果率、平均/P95 耗时、高频词和最近查询；搜索与知识问答触发的检索会分别记录。

系统治理页位于 `/admin/settings`。系统管理员可以热更新租户检索候选窗口、最低相关性、默认分页数、反馈开关与审计保留周期，并查看完整租户审计日志；知识管理员可以只读查看运行配置以及近 7/30/90 天的检索质量、用户反馈和模型成本。模型、索引、上传限制等部署级配置在页面中只读展示，仍由环境变量和部署流程管理。搜索响应会返回查询事件 ID，全文搜索页据此收集有用/无用反馈及问题原因。

外部模型适配器提供每分钟请求上限、全局/租户/用户/operation-model TPM 预留与结算、并发队列、指数退避、三态熔断、超时和取消传播。每次 provider attempt 都独立占用 RPM/TPM；成功后按实际 usage 结算，usage 缺失或请求失败时保留保守估算。熔断恢复窗口结束后只放行有限的 half-open 探针，达到连续成功阈值后才恢复正常流量，探针失败会立即重新打开熔断器。启用 Redis 模型配额后，API 和 Worker 多副本共享配额与熔断状态。模型调用事件持久化到 PostgreSQL，租户质量页按所选时间窗口汇总 API 与 Worker 的 token 用量和估算成本；`GET /api/metrics/models` 仍提供当前 API 进程的实时运行快照。当前向量列固定为 384 维；健康检查会同时验证 PostgreSQL 列类型和模型探针，生产环境强制设置 `MODEL_VALIDATE_ON_STARTUP=true`。

API 身份只从服务端鉴权上下文取得，客户端提交的 `tenantId`、`createdBy` 和检索 `principalIds` 不参与授权。开发默认 `AUTH_MODE=demo`，固定身份来自 `AUTH_DEMO_*`；生产环境强制 `AUTH_MODE=jwt`，并通过 `AUTH_JWT_JWKS_URL`、issuer、audience 和声明名校验 Bearer JWT。租户级能力保存在 `permissionKeys`，资源 ACL 主体保存在 `principalIds`，停用的租户或用户会被拒绝。新文档默认仅创建者可读，文档直接 ACL 与空间/文件夹继承 ACL 分开维护。完整设计见 `docs/access-control-design.md`。

知识问答工具栏可以新建、读取和删除当前用户的会话；会话消息与引用保存在 PostgreSQL。`CHAT_RETENTION_DAYS` 控制保留天数，后台清理默认每 6 小时执行一次。流式回答可由停止按钮或客户端断连取消，取消信号会继续传递到检索、重排和外部 Chat 请求。

PDF 最多 500 页；PDF/DOCX 最多 500 张图片、单图 10 MB、图片总量 50 MB。XLSX 最多 100 个 Sheet、每 Sheet 50,000 行和 256 列、整份 500,000 个单元格；PPTX 最多 500 页和 250,000 个表格单元格。Office 包最多 10,000 个条目、解压后 200 MB，输出 Markdown 最多 5,000,000 字符，各解析子步骤最长 60 秒。ExcelJS 或自研 PPTX OOXML 路径出现兼容性错误时会降级到 officeparser，资源限制错误不会降级。

匿名黄金样例位于 `packages/rag/test-fixtures`，可用本地 E2E 脚本验收：

```bash
node scripts/e2e-document-upload.mjs packages/rag/test-fixtures/parser-sample.docx
node scripts/e2e-document-upload.mjs packages/rag/test-fixtures/parser-sample.pdf
node scripts/e2e-document-upload.mjs packages/rag/test-fixtures/parser-sample.xlsx
node scripts/e2e-document-upload.mjs packages/rag/test-fixtures/parser-sample.pptx
```

可靠性 E2E 需要一个已发布文档及其当前版本 ID，会依次验证新版本失败、3 次重试、死信、旧版本保留、人工重试、取消和异步删除：

```bash
node scripts/e2e-ingestion-reliability.mjs <documentId> <currentReadyVersionId>
```

混合检索和权限过滤验收：

```bash
node scripts/e2e-hybrid-search.mjs
```

全文搜索分页、Facet 与检索治理验收：

```bash
pnpm e2e:search-governance
```

系统设置、搜索反馈、审计与质量成本治理验收：

```bash
pnpm e2e:system-governance
```

可信身份、流式引用回答和无证据拒答验收：

```bash
pnpm e2e:rag
```

运行固定 RAG 质量评测集（会临时上传六份匿名样例并在结束后清理）：

```bash
pnpm eval:rag
```

评测会记录检索参数与模型快照，输出答案、引用精确率/召回率、分片级
`Recall@K`/`nDCG@K`、向量/关键词/RRF/重排/候选整理/MMR 阶段命中、分阶段耗时、
P50/P95/P99、模型成本和 95% 置信区间。报告默认写入
`.tmp/rag-evaluations/`。可重复运行或比较多个候选窗口：

```bash
pnpm eval:rag -- --repetitions=10 --candidate-limits=50,100,200,300
```

候选窗口矩阵运行期间会临时更新当前租户设置，并在结束后恢复原值。诊断请求需要
知识治理读取权限，且不会写入日常搜索治理统计。
仓库自带的 7 个用例主要用于链路回归；正式选择候选窗口时，应提供候选分片数量
超过最大测试窗口、包含困难负例且完成人工相关性标注的自定义评测集。

从 MinIO Markdown 全量重建指定租户的 pgvector 与 Elasticsearch 投影：

```bash
pnpm --filter @knowledge-base/worker search:rebuild -- <tenantId>
```

升级到版本审核与发布可见性规则后，应执行一次搜索重建，为已有 Elasticsearch 文档补充发布状态并移除非当前版本。

版本审核、草稿/待审/归档检索隔离验收：

```bash
pnpm e2e:document-review
```

核心接口包括：

- `POST /api/documents/uploads`：创建文档和版本，返回预签名上传信息。
- `POST /api/documents/:documentId/versions/:versionId/complete`：确认上传并幂等投递任务。
- `POST /api/documents/:documentId/versions/:versionId/publish`：发布就绪版本并原子切换当前版本。
- `POST /api/documents/:documentId/versions/:versionId/reviews`：提交就绪版本审核。
- `POST /api/documents/:documentId/versions/:versionId/reviews/withdraw`：撤回当前待审版本。
- `GET /api/documents/:documentId/reviews/history`：读取文档版本审核历史和操作记录。
- `GET /api/reviews/tasks`：分页读取审核待办或历史任务。
- `POST /api/reviews/tasks/:reviewId/approve`：批准版本并事务性切换发布版本。
- `POST /api/reviews/tasks/:reviewId/reject`：驳回待审版本。
- `DELETE /api/documents/:documentId`：归档文档并异步清理对象与引用投影。
- `GET /api/ingestion/jobs/:jobId`：读取处理阶段和进度。
- `POST /api/ingestion/jobs/:jobId/retry`：重新处理最终失败的版本。
- `POST /api/ingestion/jobs/:jobId/cancel`：取消排队中或运行中的任务。
- `GET /api/documents/:documentId/versions/:versionId/markdown`：读取规范化 Markdown。
- `POST /api/search`：按鉴权上下文执行关键词/向量混合检索、重排并返回来源。
- `GET /api/search/preferences`：读取当前租户的默认分页数与反馈开关。
- `POST /api/search/feedback`：提交当前用户对一次检索事件的结构化反馈。
- `GET /api/search/governance`：读取当前租户的检索质量、耗时与查询趋势。
- `GET /api/admin/settings`：读取租户可调参数与部署级只读配置。
- `PUT /api/admin/settings`：更新租户检索和审计保留参数并记录审计事件。
- `GET /api/admin/audit`：按行为与资源类型分页读取租户审计日志。
- `GET /api/admin/quality`：汇总检索、反馈及当前 API 实例的模型成本指标。
- `POST /api/answers`：生成并持久化带引用的知识库回答。
- `POST /api/answers/stream`：以 SSE 输出回答元数据、token 和最终结果。
- `GET /api/answers/conversations`：分页读取当前用户的会话。
- `GET /api/answers/conversations/:conversationId`：读取消息与持久化引用。
- `DELETE /api/answers/conversations/:conversationId`：删除当前用户拥有的会话。
- `GET /api/metrics/models`：读取当前 API 实例内的模型调用指标。

孤儿对象扫描默认关闭。确认生产保留策略后设置 `ORPHAN_CLEANUP_ENABLED=true`；`ORPHAN_OBJECT_GRACE_HOURS` 控制最短保留时间，扫描不会删除仍被未清理文档引用的对象。

```bash
pnpm test
pnpm lint
pnpm check-types
pnpm build
```

项目设计见 [PROJECT_BREAKDOWN.md](./PROJECT_BREAKDOWN.md)，文档迁移进度见 [docs/document-ingestion-migration-plan.md](./docs/document-ingestion-migration-plan.md)。下一阶段是使用目标环境的真实 IdP 和模型服务做预发布联调，并执行多副本配额、备份恢复、索引重建和故障演练。
