# 文档模块与文件解析能力迁移计划

> 状态：实施中（Phase 0-4 已完成）  
> 更新日期：2026-07-30  
> 参考项目：`knowledge-hub-backend-01`、`knowledge-hub-backend-02`

## 1. 目标

将两个参考项目中的文档管理和文件解析能力迁移到当前 monorepo，形成以下纵向闭环：

```text
创建文档版本
  -> 客户端直传原文件到 MinIO
  -> API 校验上传并投递 BullMQ 任务
  -> Worker 下载文件并解析为 Markdown
  -> 保存 Markdown、图片等解析产物
  -> 保存来源锚点和处理状态
  -> 切片并写入 Elasticsearch/pgvector
  -> 文档版本切换为 READY
  -> Web 展示进度、Markdown 预览和来源信息
```

本计划迁移的是核心能力，不直接复制两个独立 NestJS 应用。迁移后的代码必须遵守当前项目的 API、Worker、共享包和基础设施边界。

## 2. 已确认的架构决策

### 2.1 不引入 MongoDB

- PostgreSQL 保存业务事实、文档元数据、不可变版本、任务状态、来源锚点和权限。
- MinIO 保存原文件、规范化 Markdown、PDF 图片及其他解析产物。
- Elasticsearch 和 pgvector 保存可重建的检索投影。
- Redis 只用于 BullMQ、临时进度和短期缓存。

参考项目使用 MongoDB 保存单段 Markdown 正文，但当前需求不包含正文局部查询、多人协同编辑或 MongoDB 聚合。继续引入 MongoDB 会增加跨库一致性、备份恢复和运维成本，因此不迁移相关 Mongoose Schema 和双库补偿逻辑。

### 2.2 保持 UUID 标识体系

当前 contracts 使用 UUID。参考项目中的雪花 ID 和 PostgreSQL `BIGINT` transformer 不迁移，避免一个系统内混用 UUID、Snowflake ID 和 Mongo ObjectId。

### 2.3 解析只能在 Worker 中执行

生产链路不采用 API 内存接收大文件并同步解析的方式。API 负责鉴权、创建版本、签发上传凭证和投递任务；Worker 负责耗时、可重试的解析和索引工作。

### 2.4 所有对象保持私有

数据库只保存 MinIO `bucket` 和 `objectKey`，不保存永久公共 URL。用户下载原文件或查看解析图片时，API 必须重新校验租户和 ACL，再签发短期 URL。

## 3. 迁移范围

### 3.1 本次迁移

- 文档元数据 CRUD、软删除和归档。
- 不可变文档版本。
- MinIO 预签名上传、校验和私有下载。
- BullMQ 文档处理任务、进度、重试、取消和失败记录。
- TXT、Markdown、DOCX、PDF、XLSX、PPTX 转 Markdown。
- PDF 页码、PPTX 幻灯片、XLSX Sheet/行和 Markdown 标题来源锚点。
- PDF 图片等派生资源保存。
- Markdown 预览。
- 为后续切片、Embedding 和检索提供稳定输入。

### 3.2 暂不迁移

- MongoDB、Mongoose Schema 和 PostgreSQL/MongoDB 双写。
- RustFS 服务本身；仅复用其 S3 兼容客户端思路，目标存储仍为 MinIO。
- 浏览、点赞、评论、收藏等内容社区字段。
- 扫描 PDF OCR。
- XLS、DOC、PPT 等旧版二进制 Office 格式。
- 音频、视频和知识图谱解析。
- 多人在线编辑和正文局部更新。

## 4. 参考代码取舍

| 参考实现                    | 迁移方式             | 说明                                |
| --------------------------- | -------------------- | ----------------------------------- |
| `backend-01` 文档 CRUD      | 按领域模型重写       | 保留列表、详情、更新和归档语义      |
| `backend-01` `kh_document`  | 不直接复制           | 拆为逻辑文档和不可变版本            |
| `backend-01` MongoDB 正文   | 不迁移               | Markdown 改存 MinIO                 |
| `backend-01` 雪花 ID        | 不迁移               | 保持 UUID                           |
| `backend-02` Markdown 工具  | 适配迁移             | 移除 NestJS 依赖并增加测试          |
| `backend-02` 各格式 parser  | 适配迁移             | 改为统一 `ParseResult`，补来源锚点  |
| `backend-02` RustFS service | 重写为 MinIO adapter | 保存私有 object key，不返回公共 URL |
| `backend-02` 同步上传接口   | 不迁移               | 改为预签名直传和异步 Worker         |
| `backend-02/test-files`     | 筛选后迁移           | 先检查敏感信息，再作为黄金测试样例  |

参考入口：

- [文档双库服务](../knowledge-hub-backend-01/src/document/document.service.ts)
- [文件解析分发器](../knowledge-hub-backend-02/src/document/parser/file-parser.service.ts)
- [PDF 解析器](../knowledge-hub-backend-02/src/document/parser/parsers/pdf.parser.ts)
- [DOCX 解析器](../knowledge-hub-backend-02/src/document/parser/parsers/docx.parser.ts)
- [XLSX 解析器](../knowledge-hub-backend-02/src/document/parser/parsers/xlsx.parser.ts)
- [PPTX 解析器](../knowledge-hub-backend-02/src/document/parser/parsers/pptx.parser.ts)

## 5. 目标代码结构

```text
apps/
  api/src/
    documents/                 # 文档、版本、上传、下载和任务查询 API
    storage/                   # NestJS MinIO module
  worker/src/
    ingestion/
      document-ingestion.processor.ts
      stages/                  # parse/normalize/chunk/index stage

packages/
  contracts/src/
    documents.ts              # API DTO/Zod Schema
    ingestion.ts              # BullMQ payload/event/result
  domain/src/
    documents.ts              # 文档与发布规则
    ingestion.ts              # 状态机和领域约束
  database/                    # 新增
    src/entities/
    src/migrations/
    src/repositories/
  object-storage/              # 新增，API 与 Worker 共用
    src/index.ts
  rag/src/
    parsing/
      file-parser.ts
      parser.types.ts
      markdown.ts
      parsers/
        plain-text.ts
        docx.ts
        pdf.ts
        xlsx.ts
        pptx.ts
    chunking/
```

如果 `database` 或 `object-storage` 在首个纵向切片中只有一个消费者，可以先放在对应 app 内；当 API 与 Worker 确认共同使用时再提升为共享包。

## 6. 数据模型

### 6.1 `document`

逻辑文档，不直接保存正文。

| 字段                               | 说明                       |
| ---------------------------------- | -------------------------- |
| `id`                               | UUID                       |
| `tenant_id`                        | 租户，必填并参与所有查询   |
| `space_id`                         | 知识空间                   |
| `folder_id`                        | 可空目录                   |
| `title`                            | 文档标题                   |
| `summary`                          | 摘要                       |
| `status`                           | `DRAFT/PUBLISHED/ARCHIVED` |
| `current_ready_version_id`         | 当前可检索版本             |
| `created_by/updated_by`            | 操作人                     |
| `created_at/updated_at/deleted_at` | 审计字段                   |

### 6.2 `document_version`

正文和原文件的不可变版本。

| 字段                                   | 说明                   |
| -------------------------------------- | ---------------------- |
| `id`                                   | UUID                   |
| `tenant_id/document_id`                | 租户和逻辑文档         |
| `version_no`                           | 文档内单调递增版本号   |
| `source_bucket/source_object_key`      | 原文件位置             |
| `markdown_bucket/markdown_object_key`  | 规范化 Markdown 位置   |
| `source_filename/mime_type/size_bytes` | 原文件信息             |
| `sha256`                               | 幂等、去重和完整性校验 |
| `parser_name/parser_version`           | 解析器可追踪版本       |
| `ingestion_status`                     | 当前处理状态           |
| `word_count`                           | 解析后字数             |
| `error_code/error_message`             | 最近失败原因           |
| `created_at/ready_at`                  | 生命周期时间           |

唯一约束：`(tenant_id, document_id, version_no)`。

### 6.3 `document_asset`

保存 PDF 图片等派生资源的元数据。

关键字段：`tenant_id`、`document_version_id`、`kind`、`object_key`、`mime_type`、`size_bytes`、`sha256`、`page_no`、`ordinal`。

### 6.4 `document_source_anchor`

保存 Markdown 区间与原文件位置的映射。

关键字段：`document_version_id`、`anchor_type`、`page_no`、`slide_no`、`sheet_name`、`row_start`、`row_end`、`heading`、`markdown_offset_start`、`markdown_offset_end`。

### 6.5 任务与一致性表

- `ingestion_job`：一次版本处理任务。
- `ingestion_stage`：各阶段开始、结束、进度、错误和处理器版本。
- `outbox_event`：PostgreSQL 事务提交后可靠投递 BullMQ。
- `resource_acl`：文档或文件夹对用户、角色、部门的授权。

## 7. 核心契约

### 7.1 解析结果

```ts
export type ParseResult = {
  markdown: string;
  anchors: SourceAnchor[];
  assets: ParsedAsset[];
  warnings: string[];
  stats: {
    characters: number;
    pages?: number;
    slides?: number;
    sheets?: number;
  };
};
```

Parser 不返回业务文档、不更新数据库，也不生成永久公共 URL。

### 7.2 BullMQ 任务

```ts
export type DocumentIngestionJob = {
  tenantId: string;
  documentId: string;
  documentVersionId: string;
  sourceBucket: string;
  sourceObjectKey: string;
  sourceFilename: string;
  mimeType: string;
  sha256: string;
  requestedAt: string;
};
```

建议使用 `documentVersionId` 作为 BullMQ `jobId`，保证同一版本重复提交不会产生多个并发任务。

### 7.3 处理状态机

```text
RECEIVED -> STORED -> PARSING -> NORMALIZING -> CHUNKING
         -> INDEXING -> READY
```

非主路径状态：`RETRYING`、`FAILED`、`CANCELLED`。

业务发布状态与处理状态必须分开：文档可以是 `PUBLISHED`，但新版本仍在 `PARSING`；新版本失败时继续使用旧的 `READY` 版本。

## 8. API 设计

| 方法     | 路径                                                      | 用途                              |
| -------- | --------------------------------------------------------- | --------------------------------- |
| `POST`   | `/api/documents/uploads`                                  | 创建文档/版本并返回预签名上传信息 |
| `POST`   | `/api/documents/:documentId/versions/:versionId/complete` | 校验对象并投递任务                |
| `GET`    | `/api/documents`                                          | 按租户、空间、目录、状态分页查询  |
| `GET`    | `/api/documents/:documentId`                              | 文档详情与当前版本                |
| `PATCH`  | `/api/documents/:documentId`                              | 更新标题、摘要、目录等元数据      |
| `DELETE` | `/api/documents/:documentId`                              | 归档或软删除                      |
| `GET`    | `/api/documents/:documentId/versions`                     | 版本列表                          |
| `GET`    | `/api/documents/:documentId/versions/:versionId/markdown` | 鉴权后读取 Markdown               |
| `GET`    | `/api/ingestion/jobs/:jobId`                              | 查询任务和阶段进度                |
| `POST`   | `/api/ingestion/jobs/:jobId/retry`                        | 重试失败任务                      |
| `POST`   | `/api/ingestion/jobs/:jobId/cancel`                       | 取消未完成任务                    |

首个版本可以保留一个仅限开发环境使用的代理上传接口，但生产流程必须使用预签名直传。

## 9. 分阶段实施清单

实施状态（2026-07-30）：Phase 0 已完成；Phase 1 除开发种子数据外已完成；Phase 2 至 Phase 7 已完成；Phase 8 的仓库内能力已经完成并通过验收，目标环境的真实身份提供方和模型服务联调仍需外部配置。除 TXT/Markdown/DOCX/PDF/XLSX/PPTX 真实文件链路外，任务可靠性、安全 RAG、会话生命周期、模型治理和固定评测集均已有可重复验证脚本。

### Phase 0：契约和架构落定

- [x] 确认不引入 MongoDB。
- [x] 确认使用 PostgreSQL + MinIO。
- [x] 确认 TypeORM 作为当前项目 ORM。
- [x] 确认 UUID 生成策略和数据库类型。
- [x] 确认 MinIO bucket 与 object key 规范。
- [x] 拆分 contracts 中的文档、版本、任务和解析结果 Schema。
- [x] 扩充 domain ingestion 状态机。

验收：API、Worker、数据库和解析器对同一组 contracts 编译通过，不存在 Snowflake ID 或 Mongo ObjectId。

### Phase 1：PostgreSQL 和 MinIO 基础

- [x] 建立 `database` 能力和 TypeORM DataSource。
- [x] 创建第一批正式 migration。
- [ ] 创建开发种子租户、用户和知识空间。
- [x] 实现 MinIO `head/get/put/delete/presign` adapter。
- [x] 初始化私有 bucket。
- [x] 扩充环境变量校验。
- [x] 健康检查覆盖 PostgreSQL、Redis 和 MinIO。

验收：全新环境可通过一条命令启动基础设施并执行迁移；重复执行 migration 和 bucket 初始化保持幂等。

### Phase 2：最小纵向切片（TXT/Markdown）

- [x] 实现创建文档和版本接口。
- [x] 实现预签名直传和完成确认接口。
- [x] 按版本 ID 幂等投递 BullMQ。
- [x] Worker 下载源文件。
- [x] 迁移 TXT/Markdown parser 和 Markdown 清洗工具。
- [x] 将规范化 Markdown 写回 MinIO。
- [x] 保存版本状态、统计和来源锚点。
- [x] 实现文档列表、任务进度和 Markdown 预览 API。
- [x] Web 工作台接入上传、阶段进度和 Markdown 预览。

验收：上传 `.txt` 或 `.md` 后可以看到阶段进度和最终 Markdown；重复调用完成接口不产生重复版本、任务或产物。

### Phase 3：DOCX 和 PDF

- [x] 迁移 Mammoth + Turndown DOCX 解析器。
- [x] 保留标题、列表、表格和链接结构。
- [x] 设计 DOCX 内嵌图片处理策略。
- [x] 迁移 `pdf-parse` PDF 解析器。
- [x] 为 PDF Markdown 写入明确的页边界。
- [x] 保存 PDF 页码来源锚点。
- [x] 将 PDF 图片保存为私有 `document_asset`。
- [x] 增加页数、图片数、解析超时和内存限制。

验收：引用可以从 Markdown 区间定位到 PDF 页码；单张图片失败只产生 warning，不使整份文档失败。

### Phase 4：XLSX 和 PPTX

- [x] 迁移 ExcelJS XLSX 解析器。
- [x] 保留 Sheet 名、表格结构、公式结果和合并单元格策略。
- [x] 增加最大 Sheet、行、列和单元格数量限制。
- [x] 保留 officeparser 降级路径。
- [x] 迁移 PPTX 解析器。
- [x] 保存 slide 标题、正文、表格和幻灯片锚点。
- [x] 用 artifact-tool 与 LibreOffice 26.8 产出的 OOXML 验证解析路径，并覆盖关系顺序变体。

验收：XLSX 结果能定位到 Sheet/行范围，PPTX 结果能定位到幻灯片页码，异常文件能够降级或返回明确错误。

### Phase 5：任务可靠性和文档版本

- [x] 所有 stage 幂等并记录输入校验和和处理器版本。
- [x] 实现指数退避、最大重试次数、取消和死信处理。
- [x] 实现 Outbox 到 BullMQ 的可靠投递。
- [x] 实现失败版本重新处理。
- [x] 实现孤儿 MinIO 对象定期清理。
- [x] 实现版本发布和 `current_ready_version_id` 原子切换。
- [x] 删除文档时异步清理现有派生投影和对象；Phase 6 新增检索投影时接入同一清理 Worker。

验收（2026-07-30）：损坏 PDF 连续执行 3 次后进入死信；人工重试生成新代次并可取消；失败的新版本未替换旧的当前版本；删除任务最终写入 `purged_at`，并将文档资产和来源锚点清零。确定性 object key、代次 jobId 和事务内重建投影保证重复任务不产生重复资产。

### Phase 6：切片与检索接入

- [x] 根据标题、页码、幻灯片和 Sheet 边界切片。
- [x] `document_chunk` 保存版本和来源锚点。
- [x] 生成 Embedding 并写入 pgvector。
- [x] 写入 Elasticsearch 关键词索引。
- [x] 索引字段携带 `tenant_id` 和有效主体 ID。
- [x] 两个检索投影成功后才切换为 `READY`。
- [x] 实现索引全量重建。

验收（2026-07-30）：结构化 Markdown 按标题和来源锚点生成确定性切片，PostgreSQL 保存 384 维向量并建立 HNSW 索引，Elasticsearch 保存关键词投影。混合检索在两个召回查询内下推 `tenant_id` 和有效主体集合过滤，使用 RRF 融合，并通过 `current_ready_version_id` 约束当前版本。端到端样例中授权主体返回 3 个带标题来源和偏移的结果，未授权主体返回 0 个；全量重建从 MinIO 恢复 10 个版本、19 个切片后结果保持一致；删除文档后两类投影均清零。

`local-hash-v1` 是无需外部密钥的确定性本地 Embedding 基线，用于开发和链路验收，不等同于生产语义模型。Phase 6 验收时 `principalIds` 仍由演示请求传入；该缺口已在 Phase 7 改为可信鉴权上下文。

### Phase 7：可信身份与带引用 RAG

- [x] 提供固定服务端身份的开发模式和 JWKS/issuer/audience 校验的 JWT 模式。
- [x] 从鉴权上下文覆盖租户、用户和有效主体，拒绝文档 ACL 越权授予。
- [x] 接入 OpenAI-compatible Embedding/Chat 模型网关和可替换 HTTP Reranker。
- [x] 新增会话、消息和引用表，并在删除文档时清理引用投影。
- [x] 实现混合召回、重排、证据阈值、提示注入隔离和无证据拒答。
- [x] 提供同步回答与 SSE 流式回答接口。
- [x] Web 提供问答、流式状态、证据列表和引用跳转。
- [x] 覆盖模型网关、ACL、提示构造、拒答、持久化和端到端链路。

验收（2026-07-30）：客户端伪造的租户和主体字段不会进入授权决策，越权文档主体返回 403；相关问题返回带编号的来源引用，无词汇重合的问题返回固定拒答和 0 条引用。SSE 事件在 Web 中逐段消费，引用可切换文档并滚动到 Markdown 预览。桌面 1440x900 与移动 390x844 视口均无水平溢出或控件重叠，浏览器控制台无错误。会话、用户/助手消息和引用均持久化到 PostgreSQL。

开发模式使用确定性本地模型，适合离线链路验收但不等同于生产问答质量。生产需使用 JWT 身份模式，配置真实 Embedding/Chat 服务，并根据评测集调整 `RAG_MIN_RELEVANCE` 和 Reranker。

### Phase 8：生产联调与质量治理

- [x] 固化 JWT/JWKS 身份契约，覆盖动态密钥轮换、token 过期、issuer/audience 错误、主体声明非法和缺失 Bearer token。
- [ ] 使用目标环境 IdP 凭据验证角色变更和跨租户策略；仓库不保存真实 issuer、audience 或密钥。
- [x] 增加模型每进程请求限流、并发队列、重试、熔断、调用成本和 token 用量指标。
- [x] 提供会话列表、历史消息读取、会话删除和定期数据保留清理。
- [x] 建立中文、DOCX、PDF、XLSX、PPTX、无答案和提示注入评测集，记录回答、引用、来源和延迟指标。
- [x] 增加答案取消、客户端断连传播、首 token 延迟、总延迟和超时观测。
- [x] 固定当前生产向量契约为 384 维，启动和健康检查同时校验数据库列与模型探针。

验收（2026-07-30）：真实文件评测集 7/7 通过，`groundedAccuracy`、答案关键词召回、引用文档召回、来源类型准确率和提示注入安全率均为 100%；本地确定性模型基线 p50 为 16 ms、p95 为 49 ms。流式 E2E 验证了客户端身份字段无效、越权 ACL 被拒、引用持久化、会话历史和删除后 404。桌面 1440x900 与移动 390x844 无水平溢出，浏览器控制台无警告或错误。

`MODEL_REQUESTS_PER_MINUTE` 是单 API/Worker 进程内的保护阈值，生产多副本的组织级配额仍应由模型供应商或 Redis/API Gateway 统一执行。当前 `document_chunk.embedding` 是 `vector(384)`；更换不同维度模型时不能只改环境变量，应创建新向量列或新投影表、离线回填、双读验证并原子切换。`MODEL_VALIDATE_ON_STARTUP=true` 在生产环境强制启用，用于阻止错误维度实例接收流量。

## 10. 测试计划

### 10.1 Parser 单元和黄金测试

- 每种格式至少一个最小文件、一个结构化文件和一个损坏文件。
- 断言 Markdown 非空、标题/表格存在、锚点正确、warning 可预期。
- 避免只做整段 Snapshot；对关键结构和锚点做显式断言。
- 迁移 `backend-02/test-files` 前检查个人信息和版权，必要时制作匿名样例。

### 10.2 集成测试

- PostgreSQL migration 和 repository。
- MinIO 上传、读取、预签名和私有访问。
- Redis/BullMQ 投递、重试、取消和重复 Job ID。
- Worker 解析后数据库与对象存储状态一致。
- 使用 Testcontainers 启动 PostgreSQL、Redis 和 MinIO。

### 10.3 E2E 测试

- 上传 -> 完成确认 -> Worker -> Markdown 预览。
- 同一文件重复提交。
- Worker 在解析中途退出后恢复。
- 新版本失败时读取旧版本。
- 无权限用户无法获取原文件、Markdown、图片或任务详情。

## 11. 安全和资源限制

- 同时校验扩展名、声明 MIME 和文件魔数，不只按扩展名分发。
- 对 ZIP/Office 文件限制解压后大小、文件数和压缩比，防止压缩炸弹。
- 限制 PDF 页数、PPTX 页数、XLSX Sheet/行/列和输出 Markdown 大小。
- 每个解析阶段设置超时、取消信号和 Worker 并发上限。
- 文档内容视为不可信输入，不能把正文中的指令当作系统指令执行。
- 日志不记录正文、密钥、预签名 URL 或完整个人信息。
- MinIO bucket 禁止公共访问，派生图片沿用文档 ACL。
- 错误响应对用户返回稳定错误码，详细堆栈只写受控日志。

## 12. 主要风险与应对

| 风险                             | 应对                                    |
| -------------------------------- | --------------------------------------- |
| PDF 表格、双栏和扫描件质量不稳定 | 保存 warning 和解析器版本；OCR 独立迭代 |
| DOCX 图片或复杂样式丢失          | 增加图片 converter 和黄金样例           |
| XLSX 产生超大 Markdown           | Sheet/行/列/输出大小限制，分段产出      |
| PPTX OOXML 正则路径兼容性不足    | 多版本样例测试，保留 officeparser 降级  |
| Worker 重试产生重复对象          | 使用版本前缀、确定性 key 和 checksum    |
| 数据库成功但队列投递失败         | PostgreSQL Outbox                       |
| 新版本失败影响线上读取           | 原子切换 `current_ready_version_id`     |
| 永久 URL 绕过权限                | 只保存私有 object key，访问时重新授权   |

## 13. 首个可交付里程碑

第一里程碑只覆盖 TXT/Markdown，但必须走完整生产形态：

```text
Web/API 创建版本
  -> MinIO 预签名直传
  -> 完成确认
  -> BullMQ
  -> Worker 解析
  -> Markdown 写入 MinIO
  -> PostgreSQL 状态 READY
  -> API 鉴权读取
  -> Web 预览
```

里程碑完成标准：

- 不存在同步大文件解析接口依赖。
- 同一版本重复提交不会产生重复任务或产物。
- Worker 重启后任务可以恢复。
- 原文件和 Markdown 均为私有对象。
- 文档、版本、任务均包含 `tenant_id`。
- API、Worker、parser、repository 和 E2E 均有有效测试。
- `pnpm lint`、`pnpm check-types`、`pnpm test` 和 `pnpm build` 全部通过。

完成该里程碑后，再按 DOCX、PDF、XLSX、PPTX 的顺序扩大格式覆盖，不同时并行重写所有解析器。
