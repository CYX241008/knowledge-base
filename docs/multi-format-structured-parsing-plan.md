# 多格式结构化解析实施计划

> 状态：已完成（不含 Git 提交）  
> 更新日期：2026-09-07  
> 适用范围：TXT、Markdown、DOCX、PDF、PPTX、XLSX

当前进度：

- [x] 建立 `StructuredDocument v2` 通用结构和 PDF v1 兼容升级。
- [x] 泛化结构持久化、读取和结构化分块。
- [x] PDF 输出迁移到 v2。
- [x] Markdown、TXT 输出结构化元素。
- [x] DOCX、PPTX、XLSX 主解析路径输出基础结构。
- [x] 泛化 OCR、Vision 和处理指标，并让 DOCX 图片接入。
- [x] 完成 PPTX 图片、坐标和阅读顺序增强。
- [x] 完成 DOCX 图片 OCR/Vision 和章节工具。
- [x] 完成 XLSX 数据区域、图表和范围工具。
- [x] 完成通用问答工具和前端引用展示。

最终验收结果：

- 数据库迁移已实际执行，结构位置、资产位置和 DOCX 资产章节字段已核验。
- `pnpm e2e:formats` 已覆盖六种格式的上传、结构读取、发布、检索、问答、工具调用和引用。
- 搜索治理、访问控制、知识组织、审核、摄取可靠性、系统治理和模型配额 E2E 已通过。
- `pnpm eval:rag` 的 7 个固定用例全部通过，`pnpm eval:pdf` 的结构专项指标全部为 1。
- PPTX 和 XLSX 的 officeparser 降级路径已加入单元测试，并返回可复核的 v2 结构。
- 浏览器已验证 PDF 页面图像与坐标高亮、PPTX 幻灯片、XLSX range 的引用预览；390 px
  移动端无横向溢出，控制台无错误。
- 全量 TypeScript、单元测试、Lint 和差异检查已通过。本次变更文件通过 Prettier；
  全仓检查仍报告 16 个既有文件的格式告警，未为本项目范围之外的文件制造格式化改动。

## 1. 目标

在保留各格式独立解析器的前提下，将现有 PDF 链路中的结构化表达、OCR、视觉理解、质量评估、结构化分块和精确引用能力推广到其他文档格式。

目标处理链路：

```text
原文件
  -> 格式专属解析
  -> 通用 StructuredDocument
  -> OCR / Vision 扩展
  -> 质量评估
  -> 结构化分块
  -> Embedding / Elasticsearch / pgvector
  -> 格式感知问答工具
  -> 精确来源引用
```

最终每种格式都应完成以下闭环：

```text
上传
  -> 解析
  -> 结构保存
  -> 分块
  -> 索引
  -> 检索
  -> 原文定位
```

## 2. 实施原则

1. 各格式保留独立解析器，不实现万能文件解析器。
2. 格式专属解析只负责还原内容，后续处理尽量复用通用能力。
3. 不为流式文档制造虚假页码，DOCX、Markdown 使用章节和文本区间定位。
4. 不把 XLSX 强行转换成页面模型，使用 Sheet、表格和行列范围定位。
5. 保持现有 PDF 功能、接口和历史结构数据兼容。
6. 每接入一种格式，同时完成结构、分块、检索、引用和测试，不只完成文本抽取。
7. 单张图片或单个视觉分析失败应产生 warning，不应使整份文档解析失败。
8. 所有新增结构数据必须能够从 PostgreSQL 和 MinIO 中的事实数据重建。

## 3. 当前基础

项目已经具备以下可复用能力：

- `DocumentParserRegistry` 按扩展名或 MIME 类型选择解析器。
- 所有解析器统一返回 `ParseResult`。
- `SourceAnchor` 已支持 document、heading、page、slide 和 sheet。
- 所有格式共用 Markdown 保存、分块、Embedding、Elasticsearch 和 pgvector 链路。
- PDF 已支持版面元素、坐标、OCR、视觉理解、结构化表格和质量评估。
- 数据库已经具备 page、slide、sheet、row、heading、element、table、figure 和坐标字段。

当前主要限制：

- `StructuredDocument` 被固定为 `format: 'pdf'`。
- 结构对象只包含 `pages`。
- OCR、Vision 和处理指标使用 PDF 专属接口。
- 结构化分块默认结构对象一定是 PDF 页面。
- 问答工具主要围绕 `read_page` 设计。
- DOCX、PPTX、XLSX、Markdown 和 TXT 尚未输出结构对象。

## 4. 目标结构模型

### 4.1 文档格式

```ts
export type DocumentFormat = 'pdf' | 'markdown' | 'text' | 'docx' | 'pptx' | 'xlsx';
```

### 4.2 来源位置

```ts
export type DocumentLocation =
  | {
      type: 'page';
      page: number;
    }
  | {
      type: 'slide';
      slide: number;
    }
  | {
      type: 'sheet';
      sheet: string;
      rowStart?: number;
      rowEnd?: number;
      range?: string;
    }
  | {
      type: 'section';
      heading?: string;
    }
  | {
      type: 'document';
    };
```

### 4.3 结构单元

```ts
export type StructuredDocumentUnit = {
  id: string;
  location: DocumentLocation;
  width?: number;
  height?: number;
  classification?: string;
  elements: StructuredDocumentElement[];
  metadata?: Record<string, unknown>;
};
```

页面、幻灯片、Sheet 和章节统一作为结构单元。只有固定画布格式需要保存宽度、高度和坐标。

### 4.4 文档元素

```ts
export type StructuredElementKind =
  'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'figure' | 'caption' | 'header' | 'footer';

export type StructuredDocumentElement = {
  id: string;
  kind: StructuredElementKind;
  location: DocumentLocation;
  order: number;
  text: string;
  markdown: string;
  offsetStart: number;
  offsetEnd: number;
  searchable: boolean;
  source: 'native' | 'ocr' | 'vision' | 'derived';
  sectionPath: string[];
  bbox?: BoundingBox;
  confidence?: number;
  tableId?: string;
  figureId?: string;
  assetFilename?: string;
};
```

### 4.5 结构化文档

```ts
export type StructuredDocumentV2 = {
  version: 2;
  format: DocumentFormat;
  units: StructuredDocumentUnit[];
  tables: StructuredDocumentTable[];
  quality: DocumentQualityReport;
};
```

质量报告保留通用字段：

```ts
export type DocumentQualityReport = {
  status: 'pass' | 'review';
  score: number;
  reasons: string[];
  metrics: Record<string, number | string | boolean>;
};
```

不同格式的专属指标写入 `metrics`，不再继续扩大 PDF 专属顶层字段。

## 5. 实施阶段

### Phase 0：建立回归基线

执行内容：

- 运行现有 parser、RAG、Worker 和 API 测试。
- 固定当前 PDF、DOCX、PPTX、XLSX、Markdown 和 TXT 输出。
- 为每种格式保存解析 Markdown、来源锚点和分块快照。
- 补充中文、英文、表格、图片和损坏文件样例。
- 记录现有 PDF v1 结构 JSON，作为兼容测试输入。

完成标准：

- 当前测试全部通过。
- 每种格式至少有一个稳定解析样例。
- 后续修改能够检测 Markdown、锚点和分块变化。

### Phase 1：泛化结构类型

主要文件：

- `packages/rag/src/structured-document.ts`
- `packages/rag/src/index.ts`
- `packages/rag/src/parsing/pdf.ts`

执行内容：

- 保留现有 `StructuredDocumentV1` 类型。
- 新增 `StructuredDocumentV2`、`DocumentLocation` 和 `StructuredDocumentUnit`。
- 增加 `upgradeStructuredDocumentV1` 转换函数。
- 增加统一的运行时结构校验入口。
- 将 PDF 解析结果改为输出 v2。
- 保持 PDF 元素 ID、表格 ID、图片 ID 和 Markdown 偏移稳定。
- 保持外部 `ParseResult` 接口不变。

完成标准：

- 新解析的 PDF 输出 v2。
- 历史 PDF v1 可以透明读取并转换为 v2。
- PDF Markdown、来源锚点、分块和引用行为保持一致。

### Phase 2：泛化结构持久化

主要文件：

- `apps/worker/src/document-ingestion.processor.ts`
- `apps/worker/src/search-projection.service.ts`
- `apps/api/src/documents/documents.service.ts`
- `packages/database/src/entities.ts`

执行内容：

- 保存所有格式的 `structure.json`。
- 移除结构读取逻辑中的 `format === 'pdf'` 限制。
- 所有结构读取统一经过版本校验和升级函数。
- 保持现有 `structure_bucket`、`structure_object_key` 和 `structure_sha256` 字段。
- 继续复用质量状态、质量分数和质量原因字段。
- 只有现有字段无法表达新来源位置时才增加数据库迁移。

完成标准：

- API 可以读取 PDF 以外格式的结构对象。
- 搜索索引可以从任意格式的结构对象重建。
- 损坏或不支持的结构版本会返回明确错误。

### Phase 3：泛化结构化分块

主要文件：

- `packages/rag/src/chunking/markdown.ts`
- `apps/worker/src/search-projection.service.ts`

执行内容：

- 将 `structure.pages` 访问改为 `structure.units`。
- 按 `DocumentLocation` 判断分块边界。
- PDF 不跨页。
- PPTX 不跨幻灯片。
- DOCX 和 Markdown 不跨章节。
- XLSX 不跨 Sheet 或独立数据表。
- 表格继续作为独立语义元素。
- 大表按完整行拆分，每个分片重复表头。
- 分片保留 element ID、table ID、figure ID、section path 和坐标。
- `buildChunkContext` 根据 location 输出页码、幻灯片、Sheet 或章节上下文。

完成标准：

- 所有格式共用一个结构化分块入口。
- 不出现跨来源位置的错误混切。
- 未提供结构对象的旧文档继续使用普通 Markdown 分块。

### Phase 4：接入 Markdown 和 TXT

主要文件：

- `packages/rag/src/parsing/plain-text.ts`
- `packages/rag/src/parsing/plain-text.test.ts`

Markdown 执行内容：

- 使用 Markdown AST 识别标题、段落、列表、表格和代码块。
- 按标题建立 section unit。
- 维护完整章节路径。
- 表格和代码块作为独立元素。
- 保留元素对应的 Markdown 字符区间。

TXT 执行内容：

- 按空行和自然段生成 paragraph 元素。
- 不推断不存在的标题。
- 使用文档位置和字符区间作为引用来源。
- 长段落仍由通用分块器按长度处理。

完成标准：

- Markdown 分块不跨标题章节。
- 表格和代码块不会从中间随意切开。
- TXT 引用能够定位到准确文本区间。

### Phase 5：接入 PPTX

主要文件：

- `packages/rag/src/parsing/pptx.ts`
- `packages/rag/src/parsing/pptx.test.ts`
- `packages/rag/src/parsing/office-package.ts`

执行内容：

- 使用结构化 XML 解析逐步替换正文路径中的 OOXML 正则解析。
- 每张幻灯片生成一个 slide unit。
- 提取标题、文本框、列表、表格、图片和说明文字。
- 保存文本框和图片的归一化坐标。
- 根据占位符、坐标和层级恢复阅读顺序。
- 识别并过滤页脚、页码和重复模板文本。
- 根据 relationship 提取 `ppt/media` 图片。
- 表格同时保存 Markdown 和二维行列数据。
- 对文档截图执行 OCR。
- 对图表、流程图和架构图执行 Vision。
- 生成 slide、element ID、table ID、figure ID 和 bbox 引用。
- 保留 officeparser 降级路径。

完成标准：

- 不跨幻灯片分块。
- 标题、正文和表格阅读顺序稳定。
- 表格问题可以读取完整二维数据。
- 图表问题可以召回视觉描述。
- 引用能够定位到幻灯片和元素区域。

### Phase 6：接入 DOCX

主要文件：

- `packages/rag/src/parsing/docx.ts`
- `packages/rag/src/parsing/docx.test.ts`

执行内容：

- 在 Mammoth HTML 转 Markdown 过程中建立结构元素。
- 将标题映射为 section unit。
- 提取段落、列表、表格、链接、图片和说明文字。
- 保留标题层级和列表层级。
- 表格同时保存 Markdown 和二维行列数据。
- 图片继承所在章节路径。
- 对文档截图和扫描件执行 OCR。
- 对图表、流程图和业务截图执行 Vision。
- 使用 heading、element ID 和 Markdown 区间定位来源。
- 不生成 DOCX 页码。

完成标准：

- DOCX 按章节结构化分块。
- 表格不会与相邻正文混切。
- 图片描述能够继承正确章节。
- 引用能够定位到章节和文本元素。

### Phase 7：接入 XLSX

主要文件：

- `packages/rag/src/parsing/xlsx.ts`
- `packages/rag/src/parsing/xlsx.test.ts`

执行内容：

- 每个 Sheet 生成一个 sheet unit。
- 识别 Excel Table 和连续有效数据区域。
- 保存表格 ID、Sheet 名、行范围和 A1 range。
- 保存格式化值、公式和缓存结果。
- 保留合并单元格主值。
- 公式缺少缓存结果时写入质量告警。
- 不同数据区域分别生成表格元素。
- 大表按行窗口分块，并在每片重复表头。
- 不将不同 Sheet 或数据表混入同一分片。
- 解析嵌入图片和图表关系。
- 图表优先读取源数据，Vision 作为补充描述。

完成标准：

- 引用能够定位到 Sheet 和行范围。
- 大表分块始终包含表头。
- 表格比较能够获取完整行列上下文。
- 公式、合并单元格和资源限制行为有测试覆盖。

### Phase 8：泛化 OCR、Vision 和处理指标

主要文件：

- `packages/rag/src/structured-document.ts`
- `apps/worker/src/tesseract-ocr.service.ts`
- `apps/worker/src/document-vision.service.ts`
- `apps/worker/src/document-processing-metrics.service.ts`
- `apps/worker/src/worker.module.ts`

执行内容：

- 新增格式无关的 `OcrEngine` 和 `VisionEngine`。
- 输入位置从固定 `page` 改为 `DocumentLocation`。
- PDF 解析器继续负责将页面渲染为图片。
- DOCX 和 PPTX 解析器负责提取嵌入图片。
- OCR 和 Vision 服务只处理标准图片输入。
- 将服务逐步重命名为 `TesseractOcrService` 和 `DocumentVisionService`。
- 暂时保留旧 PDF 类型别名，降低迁移风险。
- 指标增加 format、location、provider、model、duration、status 和 cacheHit。
- 格式专属配置允许覆盖通用默认配置。

完成标准：

- 同一个 OCR/Vision 服务能够处理 PDF、PPTX 和 DOCX 图片。
- 单张图片失败只产生 warning 和失败指标。
- OCR/Vision 的预算、超时、缓存和成本记录保持有效。

### Phase 9：泛化问答工具

主要文件：

- `apps/api/src/answers/document-tools.service.ts`
- `apps/api/src/answers/answers.service.ts`
- `packages/contracts/src/index.ts`

统一工具：

```text
search_document
read_location
get_table
read_range
inspect_figure
get_source
```

执行内容：

- `read_location` 根据 location 类型读取 page、slide、sheet 或 section。
- `read_page` 保留为 PDF 兼容工具。
- PPTX 支持读取指定幻灯片。
- DOCX 和 Markdown 支持读取指定章节。
- XLSX 支持读取 Sheet、表格和行范围。
- `get_table` 支持所有包含结构化表格的格式。
- `inspect_figure` 支持 PDF、PPTX 和 DOCX。
- 工具调用轨迹记录 location 和资源 ID。
- 问题意图识别增加幻灯片、章节、Sheet、行列范围等关键词。

完成标准：

- 工具不再假设所有结构都包含 PDF 页面。
- 每种格式都能够读取比普通检索分片更完整的上下文。
- 所有工具调用继续执行租户和文档 ACL 校验。

### Phase 10：前端引用展示

主要文件：

- `apps/web/src/components/document-workspace.tsx`
- `apps/web/src/components/search-workspace.tsx`

执行内容：

- PDF 保持页面图片和坐标高亮。
- PPTX 显示幻灯片号、元素文本和坐标信息。
- DOCX、Markdown 和 TXT 显示章节及文本区间。
- XLSX 显示 Sheet、行范围和结构化表格。
- 引用标签根据 location 类型显示“第 N 页”“幻灯片 N”“Sheet/行范围”或“章节”。
- 没有专用原文件渲染器时，使用结构化内容预览，不阻塞引用能力上线。

完成标准：

- 所有格式的引用都能跳转到可理解的原文上下文。
- PDF 现有预览和坐标高亮不回退。
- 长标题、Sheet 名和范围信息不会破坏布局。

### Phase 11：质量评估

通用指标：

- 可搜索文本覆盖率。
- 空结构单元数量。
- OCR 完成率。
- OCR 平均置信度。
- 图片分析覆盖率。
- 表格解析成功率。
- 阅读顺序异常数量。
- 截断和资源限制数量。

格式专属指标：

| 格式     | 指标                                                 |
| -------- | ---------------------------------------------------- |
| PDF      | 扫描页、混排页、空白页、重复页眉页脚                 |
| PPTX     | 空幻灯片、模板噪声、未分析图片、阅读顺序异常         |
| DOCX     | 标题层级异常、表格转换失败、图片遗漏                 |
| XLSX     | 无缓存公式、超大数据区域、截断 Sheet、异常合并单元格 |
| Markdown | 标记语法错误、超大代码块、异常表格                   |
| TXT      | 空文档、超长段落、编码错误                           |

完成标准：

- 所有格式产生统一的 pass/review、score 和 reasons。
- 质量原因能够在 API 和管理界面中查看。
- 格式专属指标不污染通用顶层结构。

## 6. 测试计划

### 6.1 Parser 单元测试

每种格式至少覆盖：

- 正常文本。
- 多级标题。
- 列表。
- 表格。
- 图片或图表。
- 中文和英文混合。
- 空文件。
- 损坏文件。
- 超出资源限制。
- 降级解析路径。

### 6.2 结构契约测试

- v1 PDF 到 v2 转换。
- v2 各格式运行时校验。
- location 与 format 匹配校验。
- 元素 Markdown 偏移合法性。
- table ID 和 figure ID 引用完整性。
- bbox 数值范围校验。

### 6.3 分块测试

- PDF 不跨页。
- PPTX 不跨幻灯片。
- DOCX 和 Markdown 不跨章节。
- XLSX 不跨 Sheet 和数据表。
- 表格按完整行拆分。
- 大表分片重复表头。
- 不可搜索元素不会进入索引。

### 6.4 Worker 和 API 测试

- 结构 JSON 保存和校验和验证。
- 历史结构读取。
- 重试不会生成重复资产。
- 搜索索引可重建。
- ACL 在结构读取和工具调用时生效。
- 部分 OCR/Vision 失败不会中断整份文档。

### 6.5 E2E 测试

每种格式验证：

```text
上传
  -> 解析 ready
  -> 结构可读取
  -> 分片可查询
  -> 问答可命中
  -> 引用位置正确
```

### 6.6 固定评测集

为每种格式建立独立评测类别：

- 文本事实查询。
- 标题或章节查询。
- 页码、幻灯片或 Sheet 定位。
- 表格比较。
- 图表理解。
- 无答案问题。
- 文档提示注入。

## 7. 兼容与迁移策略

1. 不批量修改历史 `structure.json`。
2. 读取历史 PDF v1 时在内存中升级。
3. 文档重新摄取或重建索引时写入 v2。
4. 保留现有 PDF API 和工具名称，内部映射到通用能力。
5. 未生成结构对象的历史非 PDF 文档继续使用普通 Markdown 分块。
6. 可通过后台重建任务逐步为历史文档生成结构对象。
7. 结构版本未知时拒绝解析，避免静默产生错误引用。

## 8. 提交顺序

按以下顺序拆分实现和提交：

1. 通用结构类型和 PDF v1 兼容适配器。
2. PDF 输出 v2，并完成 PDF 回归测试。
3. 结构持久化和 API 读取泛化。
4. 结构化分块和检索上下文泛化。
5. Markdown/TXT 结构化输出。
6. PPTX 结构化、图片和表格能力。
7. DOCX 结构化、图片和表格能力。
8. XLSX Sheet、范围和表格能力。
9. OCR、Vision 和指标服务泛化。
10. 问答工具泛化。
11. 前端多格式引用展示。
12. 全格式 E2E、评测集和运行文档更新。

每个提交必须保持：

- TypeScript 构建通过。
- 相关单元测试通过。
- 已完成格式的 E2E 不回退。
- 不混入无关重构。

## 9. 最终完成标准

- TXT、Markdown、DOCX、PDF、PPTX 和 XLSX 均输出统一结构对象。
- 各格式保留自身正确的位置语义。
- 所有格式共用结构化分块、索引和检索链路。
- PDF、PPTX 和 DOCX 共用 OCR/Vision 服务。
- 表格在 PDF、DOCX、PPTX 和 XLSX 中均作为结构化数据保存。
- 问答工具可以读取页面、幻灯片、章节、Sheet、表格和图片。
- 引用包含准确的来源位置和元素信息。
- 历史 PDF v1 数据和现有 PDF 预览保持兼容。
- 所有格式具备固定测试样例和可重复执行的评测集。
