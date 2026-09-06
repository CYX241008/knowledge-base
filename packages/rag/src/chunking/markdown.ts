import { createHash } from 'node:crypto';
import type { SourceAnchor } from '../index';
import type { StructuredDocument, StructuredDocumentElement } from '../structured-document';

export const CHUNKER_VERSION = 'document-elements-v2';

export type MarkdownChunk = {
  id: string;
  ordinal: number;
  content: string;
  contentSha256: string;
  tokenCount: number;
  offsetStart: number;
  offsetEnd: number;
  anchor: SourceAnchor;
};

export type ChunkMarkdownOptions = {
  maxCharacters?: number;
  overlapCharacters?: number;
  structure?: StructuredDocument;
};

type StructuralRange = {
  start: number;
  end: number;
  anchor: SourceAnchor;
};

const sourcePriority: Record<SourceAnchor['type'], number> = {
  document: 0,
  heading: 1,
  page: 2,
  slide: 2,
  sheet: 2,
};

export function chunkMarkdown(
  documentVersionId: string,
  markdown: string,
  anchors: SourceAnchor[],
  options: ChunkMarkdownOptions = {},
): MarkdownChunk[] {
  const maxCharacters = options.maxCharacters ?? 1_200;
  const overlapCharacters = options.overlapCharacters ?? 120;
  if (maxCharacters < 100) throw new Error('maxCharacters must be at least 100');
  if (overlapCharacters < 0 || overlapCharacters >= maxCharacters)
    throw new Error('overlapCharacters must be between 0 and maxCharacters');
  if (!markdown.trim()) return [];
  if (options.structure) {
    return chunkStructuredDocument(
      documentVersionId,
      markdown,
      options.structure,
      maxCharacters,
      overlapCharacters,
    );
  }

  const ranges = structuralRanges(markdown, anchors);
  const chunks: MarkdownChunk[] = [];
  for (const range of ranges) {
    let cursor = trimStart(markdown, range.start, range.end);
    const rangeEnd = trimEnd(markdown, cursor, range.end);
    while (cursor < rangeEnd) {
      const proposedEnd = Math.min(cursor + maxCharacters, rangeEnd);
      const rawEnd =
        proposedEnd === rangeEnd ? rangeEnd : preferredBreak(markdown, cursor, proposedEnd);
      const contentStart = trimStart(markdown, cursor, rawEnd);
      const contentEnd = trimEnd(markdown, contentStart, rawEnd);
      if (contentEnd > contentStart) {
        const content = markdown.slice(contentStart, contentEnd);
        const ordinal = chunks.length + 1;
        chunks.push({
          id: deterministicChunkId(documentVersionId, ordinal),
          ordinal,
          content,
          contentSha256: createHash('sha256').update(content).digest('hex'),
          tokenCount: estimateTokenCount(content),
          offsetStart: contentStart,
          offsetEnd: contentEnd,
          anchor: { ...range.anchor, offsetStart: contentStart, offsetEnd: contentEnd },
        });
      }
      if (rawEnd >= rangeEnd) break;
      const nextCursor = Math.max(cursor + 1, rawEnd - overlapCharacters);
      cursor = trimStart(markdown, nextCursor, rangeEnd);
    }
  }
  return chunks;
}

function structuralRanges(markdown: string, anchors: SourceAnchor[]): StructuralRange[] {
  const normalized = anchors
    .map((anchor) => ({
      ...anchor,
      offsetStart: clamp(anchor.offsetStart, 0, markdown.length),
      offsetEnd: clamp(anchor.offsetEnd, 0, markdown.length),
    }))
    .filter((anchor) => anchor.offsetEnd > anchor.offsetStart);
  const breakpoints = new Set<number>([0, markdown.length]);
  for (const anchor of normalized) {
    breakpoints.add(anchor.offsetStart);
    breakpoints.add(anchor.offsetEnd);
  }
  const points = [...breakpoints].sort((left, right) => left - right);
  const ranges: StructuralRange[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (start === undefined || end === undefined || end <= start) continue;
    const active = normalized.filter(
      (anchor) => anchor.offsetStart <= start && anchor.offsetEnd >= end,
    );
    const primary = active.sort(
      (left, right) => sourcePriority[right.type] - sourcePriority[left.type],
    )[0];
    const heading = active.find((anchor) => anchor.type === 'heading')?.heading;
    const base = primary ?? {
      type: 'document' as const,
      offsetStart: start,
      offsetEnd: end,
    };
    const anchor = {
      ...base,
      heading: base.heading ?? heading,
      offsetStart: start,
      offsetEnd: end,
    };
    const previous = ranges.at(-1);
    if (previous && previous.end === start && sameSource(previous.anchor, anchor)) {
      previous.end = end;
      previous.anchor.offsetEnd = end;
    } else {
      ranges.push({ start, end, anchor });
    }
  }
  return ranges;
}

function sameSource(left: SourceAnchor, right: SourceAnchor): boolean {
  return (
    left.type === right.type &&
    left.page === right.page &&
    left.slide === right.slide &&
    left.sheet === right.sheet &&
    left.rowStart === right.rowStart &&
    left.rowEnd === right.rowEnd &&
    left.heading === right.heading &&
    left.elementId === right.elementId &&
    left.elementType === right.elementType &&
    left.tableId === right.tableId
  );
}

function chunkStructuredDocument(
  documentVersionId: string,
  markdown: string,
  structure: StructuredDocument,
  maxCharacters: number,
  overlapCharacters: number,
): MarkdownChunk[] {
  const elements = structure.pages
    .flatMap((page) => page.elements)
    .filter(
      (element) =>
        element.offsetEnd > element.offsetStart &&
        element.offsetStart >= 0 &&
        element.offsetEnd <= markdown.length,
    )
    .sort(
      (left, right) => left.offsetStart - right.offsetStart || left.offsetEnd - right.offsetEnd,
    );
  if (elements.length === 0) return [];

  const chunks: MarkdownChunk[] = [];
  let group: StructuredDocumentElement[] = [];
  const flushGroup = () => {
    if (group.length === 0) return;
    const first = group[0];
    const last = group.at(-1);
    if (!first || !last) return;
    pushRangeChunks(
      chunks,
      documentVersionId,
      markdown,
      first.offsetStart,
      last.offsetEnd,
      groupAnchor(group),
      maxCharacters,
      overlapCharacters,
    );
    group = [];
  };

  for (const element of elements) {
    if (!element.searchable) {
      flushGroup();
      continue;
    }
    if (element.kind === 'table') {
      flushGroup();
      pushTableChunks(chunks, documentVersionId, element, maxCharacters);
      continue;
    }
    const first = group[0];
    const groupStart = first?.offsetStart ?? element.offsetStart;
    const sameContext =
      !first ||
      (first.page === element.page &&
        first.sectionPath.join('\u0000') === element.sectionPath.join('\u0000'));
    if (!sameContext || element.offsetEnd - groupStart > maxCharacters) flushGroup();
    group.push(element);
  }
  flushGroup();
  return chunks;
}

function pushRangeChunks(
  chunks: MarkdownChunk[],
  documentVersionId: string,
  markdown: string,
  start: number,
  end: number,
  anchor: SourceAnchor,
  maxCharacters: number,
  overlapCharacters: number,
): void {
  let cursor = trimStart(markdown, start, end);
  const rangeEnd = trimEnd(markdown, cursor, end);
  while (cursor < rangeEnd) {
    const proposedEnd = Math.min(cursor + maxCharacters, rangeEnd);
    const rawEnd =
      proposedEnd === rangeEnd ? rangeEnd : preferredBreak(markdown, cursor, proposedEnd);
    const contentStart = trimStart(markdown, cursor, rawEnd);
    const contentEnd = trimEnd(markdown, contentStart, rawEnd);
    if (contentEnd > contentStart) {
      pushChunk(
        chunks,
        documentVersionId,
        markdown.slice(contentStart, contentEnd),
        contentStart,
        contentEnd,
        { ...anchor, offsetStart: contentStart, offsetEnd: contentEnd },
      );
    }
    if (rawEnd >= rangeEnd) break;
    cursor = trimStart(markdown, Math.max(cursor + 1, rawEnd - overlapCharacters), rangeEnd);
  }
}

function pushTableChunks(
  chunks: MarkdownChunk[],
  documentVersionId: string,
  element: StructuredDocumentElement,
  maxCharacters: number,
): void {
  if (element.markdown.length <= maxCharacters) {
    pushChunk(
      chunks,
      documentVersionId,
      element.markdown,
      element.offsetStart,
      element.offsetEnd,
      elementAnchor(element),
    );
    return;
  }

  const lines = element.markdown.split('\n');
  const tableStart = lines.findIndex((line) => line.trimStart().startsWith('|'));
  if (tableStart < 0 || lines.length - tableStart < 3) {
    pushTextPieces(chunks, documentVersionId, element, maxCharacters);
    return;
  }
  const prefix = lines.slice(0, tableStart).join('\n').trim();
  const header = lines[tableStart];
  const separator = lines[tableStart + 1];
  if (!header || !separator) {
    pushTextPieces(chunks, documentVersionId, element, maxCharacters);
    return;
  }
  let rows: string[] = [];
  const flush = () => {
    if (rows.length === 0) return;
    const content = [prefix, [header, separator, ...rows].join('\n')].filter(Boolean).join('\n\n');
    pushChunk(
      chunks,
      documentVersionId,
      content,
      element.offsetStart,
      element.offsetEnd,
      elementAnchor(element),
    );
    rows = [];
  };
  for (const row of lines.slice(tableStart + 2)) {
    const candidate = [prefix, [header, separator, ...rows, row].join('\n')]
      .filter(Boolean)
      .join('\n\n');
    if (rows.length > 0 && candidate.length > maxCharacters) flush();
    rows.push(row);
  }
  flush();
}

function pushTextPieces(
  chunks: MarkdownChunk[],
  documentVersionId: string,
  element: StructuredDocumentElement,
  maxCharacters: number,
): void {
  for (let start = 0; start < element.markdown.length; start += maxCharacters) {
    const content = element.markdown.slice(start, start + maxCharacters).trim();
    if (!content) continue;
    pushChunk(
      chunks,
      documentVersionId,
      content,
      element.offsetStart,
      element.offsetEnd,
      elementAnchor(element),
    );
  }
}

function pushChunk(
  chunks: MarkdownChunk[],
  documentVersionId: string,
  content: string,
  offsetStart: number,
  offsetEnd: number,
  anchor: SourceAnchor,
): void {
  const ordinal = chunks.length + 1;
  chunks.push({
    id: deterministicChunkId(documentVersionId, ordinal),
    ordinal,
    content,
    contentSha256: createHash('sha256').update(content).digest('hex'),
    tokenCount: estimateTokenCount(content),
    offsetStart,
    offsetEnd,
    anchor,
  });
}

function elementAnchor(element: StructuredDocumentElement): SourceAnchor {
  return {
    type: 'page',
    page: element.page,
    heading: element.sectionPath.at(-1),
    offsetStart: element.offsetStart,
    offsetEnd: element.offsetEnd,
    elementId: element.id,
    elementIds: [element.id],
    elementType: element.kind,
    sectionPath: element.sectionPath,
    tableId: element.tableId,
    figureId: element.figureId,
    boundingBoxes: element.bbox ? [element.bbox] : undefined,
    confidence: element.confidence,
  };
}

function groupAnchor(elements: StructuredDocumentElement[]): SourceAnchor {
  const first = elements[0];
  if (!first) {
    return { type: 'document', offsetStart: 0, offsetEnd: 0 };
  }
  const kinds = new Set(elements.map((element) => element.kind));
  const confidences = elements
    .map((element) => element.confidence)
    .filter((value): value is number => value !== undefined);
  return {
    type: 'page',
    page: first.page,
    heading: first.sectionPath.at(-1),
    offsetStart: first.offsetStart,
    offsetEnd: elements.at(-1)?.offsetEnd ?? first.offsetEnd,
    elementId: first.id,
    elementIds: elements.map((element) => element.id),
    elementType: kinds.size === 1 ? first.kind : undefined,
    sectionPath: first.sectionPath,
    tableId: elements.length === 1 ? first.tableId : undefined,
    figureId: elements.length === 1 ? first.figureId : undefined,
    boundingBoxes: elements.flatMap((element) => (element.bbox ? [element.bbox] : [])),
    confidence:
      confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : undefined,
  };
}

function preferredBreak(markdown: string, start: number, end: number): number {
  const minimum = start + Math.floor((end - start) * 0.6);
  for (const marker of ['\n\n', '\n', '。', '. ', ' ']) {
    const found = markdown.lastIndexOf(marker, end);
    if (found >= minimum) return found + marker.length;
  }
  return end;
}

function trimStart(content: string, start: number, end: number): number {
  while (start < end && /\s/u.test(content[start] ?? '')) start += 1;
  return start;
}

function trimEnd(content: string, start: number, end: number): number {
  while (end > start && /\s/u.test(content[end - 1] ?? '')) end -= 1;
  return end;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function estimateTokenCount(content: string): number {
  const cjkCharacters = (
    content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []
  ).length;
  const words = (content.match(/[\p{Letter}\p{Number}]+/gu) ?? []).filter(
    (word) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word),
  ).length;
  return cjkCharacters + words;
}

function deterministicChunkId(documentVersionId: string, ordinal: number): string {
  const bytes = createHash('sha256')
    .update(`${documentVersionId}:${ordinal}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
