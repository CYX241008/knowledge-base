import { Inject, Injectable } from '@nestjs/common';
import type { AnswerToolCall, SearchDocumentHit } from '@knowledge-base/contracts';
import { getStructuredPage, type DocumentLocation } from '@knowledge-base/rag';
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
    const explicitRange = rangeFromQuestion(question);
    const wantsRange =
      explicitRange !== null ||
      /(sheet|工作表|单元格|区域|范围|行数据|列数据|cell|range|rows?)/iu.test(question);
    const explicitSlide = slideFromQuestion(question);
    const explicitSection = sectionFromQuestion(question);
    const wantsLocation =
      explicitSlide !== null ||
      explicitSection !== null ||
      /(幻灯片|章节|小节|标题|原文|上下文|slide|section|context)/iu.test(question);
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

      const targetPage = source.type === 'page' ? (explicitPage ?? source.page) : null;
      if (wantsPage && targetPage) {
        const pageStartedAt = Date.now();
        const page = getStructuredPage(structure, targetPage);
        const content = page?.elements
          .filter((element) => element.searchable)
          .map((element) => element.markdown)
          .filter(Boolean)
          .join('\n\n');
        if (page && content) {
          enriched.push(
            syntheticHit(source, `page-${targetPage}`, content, {
              location: page.location,
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
            { type: 'page', page: targetPage },
          ),
        );
      }

      const targetSheet = explicitRange?.sheet ?? source.sheet;
      const targetRange = explicitRange?.range ?? source.range;
      if (wantsRange && targetSheet) {
        const rangeStartedAt = Date.now();
        const matchingUnits = structure.units
          .filter(
            (unit) =>
              unit.location.type === 'sheet' &&
              unit.location.sheet.toLocaleLowerCase() === targetSheet.toLocaleLowerCase() &&
              (!targetRange ||
                !unit.location.range ||
                rangesOverlap(unit.location.range, targetRange)),
          )
          .slice(0, 3);
        const elements = matchingUnits
          .flatMap((unit) => unit.elements)
          .filter((element) => element.searchable);
        const content = elements
          .map((element) => element.markdown)
          .filter(Boolean)
          .join('\n\n');
        const firstLocation = matchingUnits[0]?.location;
        if (content && firstLocation?.type === 'sheet') {
          enriched.push(
            syntheticHit(
              source,
              `range-${targetSheet}-${targetRange ?? firstLocation.range ?? 'all'}`,
              content,
              {
                location: {
                  type: 'sheet',
                  sheet: targetSheet,
                  rowStart: minimum(elements.map((element) => sheetRowStart(element.location))),
                  rowEnd: maximum(elements.map((element) => sheetRowEnd(element.location))),
                  range: targetRange ?? firstLocation.range,
                },
                offsetStart: Math.min(...elements.map((element) => element.offsetStart)),
                offsetEnd: Math.max(...elements.map((element) => element.offsetEnd)),
                elementIds: elements.map((element) => element.id),
              },
            ),
          );
        }
        toolCalls.push(
          toolCall(
            'read_range',
            content ? 'success' : 'skipped',
            rangeStartedAt,
            source,
            targetRange ?? null,
            content ? elements.length : 0,
            {
              type: 'sheet',
              sheet: targetSheet,
              range: targetRange ?? undefined,
            },
          ),
        );
      }

      const targetLocation = wantsLocation
        ? requestedLocation(source, explicitSlide, explicitSection)
        : null;
      if (targetLocation) {
        const locationStartedAt = Date.now();
        const matchingUnits = unitsForLocation(structure, targetLocation);
        const elements = matchingUnits
          .flatMap((unit) => unit.elements)
          .filter((element) => element.searchable);
        const content = elements
          .map((element) => element.markdown)
          .filter(Boolean)
          .join('\n\n');
        if (content) {
          enriched.push(
            syntheticHit(source, locationResourceId(targetLocation), content, {
              location: targetLocation,
              offsetStart: Math.min(...elements.map((element) => element.offsetStart)),
              offsetEnd: Math.max(...elements.map((element) => element.offsetEnd)),
              elementIds: elements.map((element) => element.id),
              boundingBoxes: elements.flatMap((element) => (element.bbox ? [element.bbox] : [])),
            }),
          );
        }
        toolCalls.push(
          toolCall(
            'read_location',
            content ? 'success' : 'skipped',
            locationStartedAt,
            source,
            locationResourceId(targetLocation),
            content ? elements.length : 0,
            targetLocation,
          ),
        );
      }

      if (wantsTables) {
        const tableStartedAt = Date.now();
        const tables = structure.tables
          .filter((table) => {
            if (targetPage) {
              return table.location.type === 'page' && table.location.page === targetPage;
            }
            if (targetSheet) {
              return (
                table.location.type === 'sheet' &&
                table.location.sheet.toLocaleLowerCase() === targetSheet.toLocaleLowerCase() &&
                (!targetRange ||
                  !table.location.range ||
                  rangesOverlap(table.location.range, targetRange))
              );
            }
            return true;
          })
          .sort(
            (left, right) =>
              termScore(right.markdown, question) - termScore(left.markdown, question),
          )
          .slice(0, 2);
        for (const table of tables) {
          const element = structure.units
            .flatMap((unit) => unit.elements)
            .find((item) => item.tableId === table.id);
          enriched.push(
            syntheticHit(source, table.id, table.markdown, {
              location: table.location,
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
            tables[0]?.location ?? null,
          ),
        );
      }

      if (wantsFigures) {
        const figureStartedAt = Date.now();
        const figures = structure.units
          .filter((unit) => {
            if (targetPage) {
              return unit.location.type === 'page' && unit.location.page === targetPage;
            }
            if (targetSheet) {
              return (
                unit.location.type === 'sheet' &&
                unit.location.sheet.toLocaleLowerCase() === targetSheet.toLocaleLowerCase() &&
                (!targetRange ||
                  !unit.location.range ||
                  rangesOverlap(unit.location.range, targetRange))
              );
            }
            return true;
          })
          .flatMap((unit) => unit.elements)
          .filter((element) => element.kind === 'figure' && element.searchable)
          .sort((left, right) => termScore(right.text, question) - termScore(left.text, question))
          .slice(0, 2);
        for (const figure of figures) {
          enriched.push(
            syntheticHit(source, figure.figureId ?? figure.id, figure.text, {
              location: figure.location,
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
            figures[0]?.location ?? null,
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
  type: SearchDocumentHit['source']['type'];
  page: number | null;
  slide: number | null;
  sheet: string | null;
  rowStart: number | null;
  rowEnd: number | null;
  range: string | null;
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
        type: hit.source.type,
        page: hit.source.page,
        slide: hit.source.slide,
        sheet: hit.source.sheet,
        rowStart: hit.source.rowStart,
        rowEnd: hit.source.rowEnd,
        range: hit.source.range ?? null,
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
    location: DocumentLocation;
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
  const sourceLocation = searchSourceLocation(location.location, source);
  return {
    chunkId: deterministicUuid(`${source.documentVersionId}:${resourceId}`),
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    title: source.title,
    content,
    context: source.context,
    score: 1,
    source: {
      ...sourceLocation,
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

function searchSourceLocation(
  location: DocumentLocation,
  source: Source,
): Pick<
  SearchDocumentHit['source'],
  'type' | 'page' | 'slide' | 'sheet' | 'rowStart' | 'rowEnd' | 'range' | 'heading'
> {
  switch (location.type) {
    case 'page':
      return {
        type: 'page',
        page: location.page,
        slide: null,
        sheet: null,
        rowStart: null,
        rowEnd: null,
        range: null,
        heading: source.heading,
      };
    case 'slide':
      return {
        type: 'slide',
        page: null,
        slide: location.slide,
        sheet: null,
        rowStart: null,
        rowEnd: null,
        range: null,
        heading: source.heading,
      };
    case 'sheet':
      return {
        type: 'sheet',
        page: null,
        slide: null,
        sheet: location.sheet,
        rowStart: location.rowStart ?? null,
        rowEnd: location.rowEnd ?? null,
        range: location.range ?? null,
        heading: source.heading,
      };
    case 'section':
      return {
        type: 'heading',
        page: null,
        slide: null,
        sheet: null,
        rowStart: null,
        rowEnd: null,
        range: null,
        heading: location.heading ?? source.heading,
      };
    case 'document':
      return {
        type: 'document',
        page: null,
        slide: null,
        sheet: null,
        rowStart: null,
        rowEnd: null,
        range: null,
        heading: source.heading,
      };
  }
}

function toolCall(
  name: AnswerToolCall['name'],
  status: AnswerToolCall['status'],
  startedAt: number,
  source: Source,
  resourceId: string | null,
  resultCount: number,
  location: DocumentLocation | null = sourceLocation(source),
): AnswerToolCall {
  return {
    name,
    status,
    durationMs: Date.now() - startedAt,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    locationType: location?.type ?? null,
    page: location?.type === 'page' ? location.page : null,
    slide: location?.type === 'slide' ? location.slide : null,
    sheet: location?.type === 'sheet' ? location.sheet : null,
    range: location?.type === 'sheet' ? (location.range ?? null) : null,
    heading: location?.type === 'section' ? (location.heading ?? null) : null,
    resourceId,
    resultCount,
  };
}

function sourceLocation(source: Source): DocumentLocation | null {
  switch (source.type) {
    case 'page':
      return source.page ? { type: 'page', page: source.page } : null;
    case 'slide':
      return source.slide ? { type: 'slide', slide: source.slide } : null;
    case 'sheet':
      return source.sheet
        ? {
            type: 'sheet',
            sheet: source.sheet,
            rowStart: source.rowStart ?? undefined,
            rowEnd: source.rowEnd ?? undefined,
            range: source.range ?? undefined,
          }
        : null;
    case 'heading':
      return { type: 'section', heading: source.heading ?? undefined };
    case 'document':
      return { type: 'document' };
  }
}

function requestedLocation(
  source: Source,
  explicitSlide: number | null,
  explicitSection: string | null,
): DocumentLocation | null {
  if (explicitSlide) return { type: 'slide', slide: explicitSlide };
  if (explicitSection) return { type: 'section', heading: explicitSection };
  if (source.type === 'slide' && source.slide) return { type: 'slide', slide: source.slide };
  if (source.type === 'heading') {
    return { type: 'section', heading: source.heading ?? undefined };
  }
  if (source.type === 'sheet' && source.sheet) {
    return {
      type: 'sheet',
      sheet: source.sheet,
      rowStart: source.rowStart ?? undefined,
      rowEnd: source.rowEnd ?? undefined,
      range: source.range ?? undefined,
    };
  }
  if (source.type === 'document') return { type: 'document' };
  return null;
}

function unitsForLocation(
  structure: Awaited<ReturnType<DocumentsService['getStructure']>>,
  location: DocumentLocation,
): typeof structure.units {
  switch (location.type) {
    case 'page':
      return structure.units.filter(
        (unit) => unit.location.type === 'page' && unit.location.page === location.page,
      );
    case 'slide':
      return structure.units.filter(
        (unit) => unit.location.type === 'slide' && unit.location.slide === location.slide,
      );
    case 'sheet':
      return structure.units.filter(
        (unit) =>
          unit.location.type === 'sheet' &&
          unit.location.sheet.toLocaleLowerCase() === location.sheet.toLocaleLowerCase() &&
          (!location.range ||
            !unit.location.range ||
            rangesOverlap(unit.location.range, location.range)),
      );
    case 'section': {
      const heading = normalizeText(location.heading ?? '');
      if (!heading) return [];
      return structure.units.filter(
        (unit) =>
          (unit.location.type === 'section' &&
            normalizeText(unit.location.heading ?? '').includes(heading)) ||
          unit.elements.some((element) =>
            element.sectionPath.some((section) => normalizeText(section).includes(heading)),
          ),
      );
    }
    case 'document':
      return structure.units;
  }
}

function locationResourceId(location: DocumentLocation): string {
  switch (location.type) {
    case 'page':
      return `page-${location.page}`;
    case 'slide':
      return `slide-${location.slide}`;
    case 'sheet':
      return `sheet-${location.sheet}-${location.range ?? 'all'}`;
    case 'section':
      return `section-${location.heading ?? 'untitled'}`;
    case 'document':
      return 'document';
  }
}

function pageFromQuestion(question: string): number | null {
  const match = question.match(/第\s*(\d+)\s*页|page\s*(\d+)/iu);
  const value = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function slideFromQuestion(question: string): number | null {
  const match = question.match(/第\s*(\d+)\s*(?:张|页)?\s*幻灯片|slide\s*(\d+)/iu);
  const value = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function sectionFromQuestion(question: string): string | null {
  const match = question.match(
    /(?:章节|小节|标题|section)\s*[:：]?\s*[“"'《]?([^”"'》,，。?？]{1,80})/iu,
  );
  return match?.[1]?.trim() || null;
}

function rangeFromQuestion(question: string): { sheet?: string; range: string } | null {
  const match = question.match(
    /(?<![\p{Letter}\p{Number}_])(?:(?:'([^']+)'|([\p{Letter}\p{Number}_-]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?:\s*(?::|到|-)\s*\$?([A-Z]{1,3})\$?(\d+))?(?![\p{Letter}\p{Number}_])/iu,
  );
  if (!match) return null;
  const startColumn = match[3]?.toUpperCase();
  const startRow = Number(match[4]);
  const endColumn = match[5]?.toUpperCase() ?? startColumn;
  const endRow = Number(match[6] ?? startRow);
  if (!startColumn || !endColumn || !Number.isInteger(startRow) || !Number.isInteger(endRow)) {
    return null;
  }
  const sheet = (match[1] ?? match[2])?.trim();
  return {
    ...(sheet ? { sheet } : {}),
    range: `${startColumn}${startRow}:${endColumn}${endRow}`,
  };
}

function rangesOverlap(left: string, right: string): boolean {
  const leftRange = parseRange(left);
  const rightRange = parseRange(right);
  if (!leftRange || !rightRange) return left.toUpperCase() === right.toUpperCase();
  return !(
    leftRange.rowEnd < rightRange.rowStart ||
    rightRange.rowEnd < leftRange.rowStart ||
    leftRange.columnEnd < rightRange.columnStart ||
    rightRange.columnEnd < leftRange.columnStart
  );
}

function parseRange(
  value: string,
): { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number } | undefined {
  const match = value.replaceAll('$', '').match(/^([A-Z]{1,3})(\d+)(?::([A-Z]{1,3})(\d+))?$/iu);
  if (!match) return undefined;
  return {
    columnStart: columnNumber(match[1] ?? ''),
    rowStart: Number(match[2]),
    columnEnd: columnNumber(match[3] ?? match[1] ?? ''),
    rowEnd: Number(match[4] ?? match[2]),
  };
}

function columnNumber(value: string): number {
  return [...value.toUpperCase()].reduce(
    (result, character) => result * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function sheetRowStart(location: DocumentLocation): number | undefined {
  return location.type === 'sheet' ? location.rowStart : undefined;
}

function sheetRowEnd(location: DocumentLocation): number | undefined {
  return location.type === 'sheet' ? location.rowEnd : undefined;
}

function minimum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.min(...present) : undefined;
}

function maximum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

function termScore(content: string, question: string): number {
  const normalized = content.toLocaleLowerCase();
  return [...new Set(question.toLocaleLowerCase().split(/[^\p{Letter}\p{Number}]+/u))]
    .filter((term) => term.length > 1)
    .reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function deduplicateHits(hits: SearchDocumentHit[]): SearchDocumentHit[] {
  const selected: SearchDocumentHit[] = [];
  for (const hit of hits) {
    const duplicateIndex = selected.findIndex(
      (existing) =>
        sameLocation(existing, hit) && contentContainsEither(existing.content, hit.content),
    );
    if (duplicateIndex === -1) {
      selected.push(hit);
      continue;
    }
    const existing = selected[duplicateIndex];
    if (
      existing &&
      normalizedContentLength(hit.content) > normalizedContentLength(existing.content)
    ) {
      selected[duplicateIndex] = hit;
    }
  }
  return selected;
}

function sameLocation(left: SearchDocumentHit, right: SearchDocumentHit): boolean {
  return (
    left.documentVersionId === right.documentVersionId &&
    left.source.type === right.source.type &&
    left.source.page === right.source.page &&
    left.source.slide === right.source.slide &&
    left.source.sheet === right.source.sheet &&
    left.source.range === right.source.range &&
    left.source.heading === right.source.heading
  );
}

function contentContainsEither(left: string, right: string): boolean {
  const normalizedLeft = normalizeText(left);
  const normalizedRight = normalizeText(right);
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
}

function normalizedContentLength(content: string): number {
  return normalizeText(content).length;
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
