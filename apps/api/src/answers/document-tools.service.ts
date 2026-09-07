import { Inject, Injectable } from '@nestjs/common';
import type { AnswerToolCall, SearchDocumentHit } from '@knowledge-base/contracts';
import { createHash } from 'node:crypto';
import type { AuthContext } from '../auth/auth-context';
import { AccessControlService } from '../access-control/access-control.service';
import { DocumentsService } from '../documents/documents.service';

@Injectable()
export class DocumentToolsService {
  constructor(
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(AccessControlService) private readonly accessControl: AccessControlService,
  ) {}

  async enrich(
    auth: AuthContext,
    question: string,
    hits: SearchDocumentHit[],
  ): Promise<{ hits: SearchDocumentHit[]; toolCalls: AnswerToolCall[] }> {
    const toolCalls: AnswerToolCall[] = [];
    const enriched = [...hits];
    const wantsTables =
      /(对比|比较|同比|环比|表格|数据|金额|比率|率|compare|versus|table|revenue|margin)/iu.test(
        question,
      );
    const wantsFigures = /(图表|图中|趋势图|流程图|架构图|chart|diagram|figure|graph)/iu.test(
      question,
    );
    const explicitPage = pageFromQuestion(question);
    const wantsPage = explicitPage !== null || /(全文|原文|上下文|page|第.+页)/iu.test(question);
    const sources = uniqueSources(hits).slice(0, 3);

    for (const source of sources) {
      await this.accessControl.assertDocumentRead(auth, source.documentId);
      let structure;
      const startedAt = Date.now();
      try {
        structure = await this.documents.getStructure(
          auth.tenantId,
          source.documentId,
          source.documentVersionId,
        );
      } catch {
        toolCalls.push(toolCall('get_source', 'skipped', startedAt, source, null, 0));
        continue;
      }

      const targetPage = explicitPage ?? source.page;
      if (wantsPage && targetPage) {
        const pageStartedAt = Date.now();
        const page = structure.pages.find((item) => item.page === targetPage);
        const content = page?.elements
          .filter((element) => element.searchable)
          .map((element) => element.markdown)
          .filter(Boolean)
          .join('\n\n');
        if (page && content) {
          enriched.push(
            syntheticHit(source, `page-${targetPage}`, content, {
              page: targetPage,
              offsetStart: Math.min(...page.elements.map((element) => element.offsetStart)),
              offsetEnd: Math.max(...page.elements.map((element) => element.offsetEnd)),
              elementIds: page.elements.map((element) => element.id),
              boundingBoxes: page.elements.flatMap((element) =>
                element.bbox ? [element.bbox] : [],
              ),
            }),
          );
        }
        toolCalls.push(
          toolCall(
            'read_page',
            page && content ? 'success' : 'skipped',
            pageStartedAt,
            source,
            `page-${targetPage}`,
            page && content ? 1 : 0,
            targetPage,
          ),
        );
      }

      if (wantsTables) {
        const tableStartedAt = Date.now();
        const tables = structure.tables
          .filter((table) => !targetPage || table.page === targetPage)
          .sort(
            (left, right) =>
              termScore(right.markdown, question) - termScore(left.markdown, question),
          )
          .slice(0, 2);
        for (const table of tables) {
          const element = structure.pages
            .flatMap((page) => page.elements)
            .find((item) => item.tableId === table.id);
          enriched.push(
            syntheticHit(source, table.id, table.markdown, {
              page: table.page,
              offsetStart: element?.offsetStart ?? source.offsetStart,
              offsetEnd: element?.offsetEnd ?? source.offsetEnd,
              elementType: 'table',
              elementIds: element ? [element.id] : [],
              tableId: table.id,
              boundingBoxes: element?.bbox ? [element.bbox] : [],
            }),
          );
        }
        toolCalls.push(
          toolCall(
            'get_table',
            tables.length ? 'success' : 'skipped',
            tableStartedAt,
            source,
            tables[0]?.id ?? null,
            tables.length,
            targetPage,
          ),
        );
      }

      if (wantsFigures) {
        const figureStartedAt = Date.now();
        const figures = structure.pages
          .filter((page) => !targetPage || page.page === targetPage)
          .flatMap((page) => page.elements)
          .filter((element) => element.kind === 'figure' && element.searchable)
          .sort((left, right) => termScore(right.text, question) - termScore(left.text, question))
          .slice(0, 2);
        for (const figure of figures) {
          enriched.push(
            syntheticHit(source, figure.figureId ?? figure.id, figure.text, {
              page: figure.page,
              offsetStart: figure.offsetStart,
              offsetEnd: figure.offsetEnd,
              elementType: 'figure',
              elementIds: [figure.id],
              figureId: figure.figureId ?? figure.id,
              boundingBoxes: figure.bbox ? [figure.bbox] : [],
              confidence: figure.confidence ?? null,
            }),
          );
        }
        toolCalls.push(
          toolCall(
            'inspect_figure',
            figures.length ? 'success' : 'skipped',
            figureStartedAt,
            source,
            figures[0]?.figureId ?? null,
            figures.length,
            targetPage,
          ),
        );
      }
    }
    return { hits: deduplicateHits(enriched), toolCalls };
  }
}

type Source = {
  documentId: string;
  documentVersionId: string;
  title: string;
  chunkId: string;
  page: number | null;
  offsetStart: number;
  offsetEnd: number;
  heading: string | null;
  context: string | null;
};

function uniqueSources(hits: SearchDocumentHit[]): Source[] {
  const sources = new Map<string, Source>();
  for (const hit of hits) {
    const key = `${hit.documentId}:${hit.documentVersionId}`;
    if (!sources.has(key)) {
      sources.set(key, {
        documentId: hit.documentId,
        documentVersionId: hit.documentVersionId,
        title: hit.title,
        chunkId: hit.chunkId,
        page: hit.source.page,
        offsetStart: hit.source.offsetStart,
        offsetEnd: hit.source.offsetEnd,
        heading: hit.source.heading,
        context: hit.context ?? null,
      });
    }
  }
  return [...sources.values()];
}

function syntheticHit(
  source: Source,
  resourceId: string,
  content: string,
  location: {
    page: number | null;
    offsetStart: number;
    offsetEnd: number;
    elementType?: SearchDocumentHit['source']['elementType'];
    elementIds?: string[];
    tableId?: string;
    figureId?: string;
    boundingBoxes?: SearchDocumentHit['source']['boundingBoxes'];
    confidence?: number | null;
  },
): SearchDocumentHit {
  return {
    chunkId: deterministicUuid(`${source.documentVersionId}:${resourceId}`),
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    title: source.title,
    content,
    context: source.context,
    score: 1,
    source: {
      type: 'page',
      page: location.page,
      slide: null,
      sheet: null,
      rowStart: null,
      rowEnd: null,
      heading: source.heading,
      offsetStart: location.offsetStart,
      offsetEnd: location.offsetEnd,
      elementType: location.elementType ?? null,
      elementIds: location.elementIds ?? [],
      sectionPath: source.heading ? [source.heading] : [],
      tableId: location.tableId ?? null,
      figureId: location.figureId ?? null,
      boundingBoxes: location.boundingBoxes ?? [],
      confidence: location.confidence ?? null,
    },
  };
}

function toolCall(
  name: AnswerToolCall['name'],
  status: AnswerToolCall['status'],
  startedAt: number,
  source: Source,
  resourceId: string | null,
  resultCount: number,
  page: number | null = source.page,
): AnswerToolCall {
  return {
    name,
    status,
    durationMs: Date.now() - startedAt,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    page,
    resourceId,
    resultCount,
  };
}

function pageFromQuestion(question: string): number | null {
  const match = question.match(/第\s*(\d+)\s*页|page\s*(\d+)/iu);
  const value = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function termScore(content: string, question: string): number {
  const normalized = content.toLocaleLowerCase();
  return [...new Set(question.toLocaleLowerCase().split(/[^\p{Letter}\p{Number}]+/u))]
    .filter((term) => term.length > 1)
    .reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function deduplicateHits(hits: SearchDocumentHit[]): SearchDocumentHit[] {
  return [
    ...new Map(
      hits.map((hit) => [
        `${hit.documentVersionId}:${hit.source.tableId ?? hit.source.figureId ?? hit.chunkId}`,
        hit,
      ]),
    ).values(),
  ];
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
