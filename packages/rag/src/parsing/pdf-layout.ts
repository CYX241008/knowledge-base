import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { BoundingBox, StructuredDocumentElement } from '../structured-document';

const moduleRequire = createRequire(__filename);
const STANDARD_FONT_DATA_URL = `${resolve(
  dirname(moduleRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')),
  '../../standard_fonts',
)}/`;

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
};

type PositionedText = {
  text: string;
  x: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
};

export type PdfLayoutLine = {
  text: string;
  x: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  column: number;
  marginRole?: 'header' | 'footer';
};

export type PdfLayoutPage = {
  page: number;
  width: number;
  height: number;
  textCharacters: number;
  textCoverage: number;
  lines: PdfLayoutLine[];
};

export async function extractPdfLayout(bytes: Uint8Array): Promise<PdfLayoutPage[]> {
  const loadingTask = getDocument({
    data: bytes.slice(),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  try {
    const pages: PdfLayoutPage[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent({
        includeMarkedContent: false,
        disableNormalization: false,
      });
      const items: PositionedText[] = [];
      for (const candidate of textContent.items) {
        if (!isTextItem(candidate) || !candidate.str.trim()) continue;
        const [x = 0, baseline = 0] = viewport.convertToViewportPoint(
          candidate.transform[4] ?? 0,
          candidate.transform[5] ?? 0,
        );
        const fontSize = Math.max(
          candidate.height,
          Math.hypot(candidate.transform[2] ?? 0, candidate.transform[3] ?? 0),
          1,
        );
        items.push({
          text: candidate.str,
          x,
          top: baseline - fontSize,
          width: Math.max(candidate.width, 1),
          height: fontSize,
          fontSize,
        });
      }
      const lines = orderLines(buildLines(items, viewport.width), viewport.width);
      const coveredArea = items.reduce(
        (sum, item) => sum + Math.max(0, item.width) * Math.max(0, item.height),
        0,
      );
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        textCharacters: items.reduce((sum, item) => sum + item.text.trim().length, 0),
        textCoverage: clamp(coveredArea / Math.max(1, viewport.width * viewport.height), 0, 1),
        lines,
      });
      page.cleanup();
    }
    return pages;
  } finally {
    await document.destroy();
  }
}

export function markRepeatedMargins(pages: PdfLayoutPage[], minimumPageRatio: number): void {
  if (pages.length === 0) return;
  const requiredPages = Math.max(2, Math.ceil(pages.length * minimumPageRatio));
  const occurrences = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const role = marginRole(line, page.height);
      if (!role) continue;
      const fingerprint = marginFingerprint(line.text);
      if (!fingerprint) continue;
      const key = `${role}:${fingerprint}`;
      const pageNumbers = occurrences.get(key) ?? new Set<number>();
      pageNumbers.add(page.page);
      occurrences.set(key, pageNumbers);
    }
  }

  for (const page of pages) {
    for (const line of page.lines) {
      const role = marginRole(line, page.height);
      if (!role) continue;
      const fingerprint = marginFingerprint(line.text);
      const repeated =
        fingerprint && (occurrences.get(`${role}:${fingerprint}`)?.size ?? 0) >= requiredPages;
      if (repeated || isObviousPageNumber(line.text, role)) line.marginRole = role;
    }
  }
}

export function createNativePageElements(
  page: PdfLayoutPage,
  sectionPath: string[],
): StructuredDocumentElement[] {
  const bodyLines = page.lines.filter((line) => !line.marginRole);
  const sortedFontSizes = bodyLines
    .map((line) => line.fontSize)
    .sort((left, right) => left - right);
  const bodyFontSize =
    median(sortedFontSizes.slice(0, Math.max(1, Math.floor(sortedFontSizes.length * 0.6)))) || 10;
  const elements: StructuredDocumentElement[] = [];
  let paragraph: PdfLayoutLine[] = [];

  const addElement = (
    kind: StructuredDocumentElement['kind'],
    lines: PdfLayoutLine[],
    text: string,
    markdown: string,
    searchable: boolean,
    headingLevel?: number,
  ) => {
    if (!text.trim() && !markdown.trim()) return;
    if (kind === 'heading' && headingLevel) {
      const effectiveLevel = Math.min(headingLevel, sectionPath.length + 1);
      sectionPath.splice(effectiveLevel - 1);
      sectionPath[effectiveLevel - 1] = text.trim();
    }
    const order = elements.length + 1;
    elements.push({
      id: `p${page.page}-e${order}`,
      kind,
      page: page.page,
      order,
      text: text.trim(),
      markdown: markdown.trim(),
      offsetStart: 0,
      offsetEnd: 0,
      searchable,
      source: 'native',
      sectionPath: [...sectionPath],
      bbox: normalizedBox(unionBox(lines), page.width, page.height),
    });
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = joinParagraphLines(paragraph);
    addElement('paragraph', paragraph, text, text, true);
    paragraph = [];
  };

  for (const line of page.lines) {
    if (line.marginRole) {
      flushParagraph();
      addElement(line.marginRole, [line], line.text, line.text, false);
      continue;
    }
    const level = headingLevel(line, bodyFontSize);
    if (level !== null) {
      flushParagraph();
      const effectiveLevel = Math.min(level, sectionPath.length + 1);
      addElement(
        'heading',
        [line],
        line.text,
        `${'#'.repeat(effectiveLevel + 2)} ${line.text}`,
        true,
        effectiveLevel,
      );
      continue;
    }
    const previous = paragraph.at(-1);
    if (previous && !canJoinParagraph(previous, line, bodyFontSize)) flushParagraph();
    paragraph.push(line);
  }
  flushParagraph();
  return elements;
}

function isTextItem(value: unknown): value is PdfTextItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<PdfTextItem>;
  return (
    typeof item.str === 'string' &&
    Array.isArray(item.transform) &&
    typeof item.width === 'number' &&
    typeof item.height === 'number'
  );
}

function buildLines(items: PositionedText[], pageWidth: number): PdfLayoutLine[] {
  const rows: PositionedText[][] = [];
  for (const item of [...items].sort((left, right) => left.top - right.top || left.x - right.x)) {
    const row = rows.find((candidate) => {
      const reference = candidate[0];
      if (!reference) return false;
      const threshold = Math.max(2, Math.min(reference.fontSize, item.fontSize) * 0.45);
      return Math.abs(reference.top - item.top) <= threshold;
    });
    if (row) row.push(item);
    else rows.push([item]);
  }

  const lines: PdfLayoutLine[] = [];
  for (const row of rows) {
    const sorted = row.sort((left, right) => left.x - right.x);
    let segment: PositionedText[] = [];
    const flush = () => {
      if (segment.length === 0) return;
      lines.push(toLine(segment));
      segment = [];
    };
    for (const item of sorted) {
      const previous = segment.at(-1);
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      if (previous && gap > pageWidth * 0.14) flush();
      segment.push(item);
    }
    flush();
  }
  return lines;
}

function toLine(items: PositionedText[]): PdfLayoutLine {
  const first = items[0];
  if (!first) throw new Error('Cannot create a PDF line without text items');
  let text = '';
  let right = first.x;
  for (const item of items) {
    const gap = item.x - right;
    if (text && gap > Math.max(2, item.fontSize * 0.22)) {
      text += gap > item.fontSize * 2.5 ? '\t' : ' ';
    }
    text += item.text;
    right = Math.max(right, item.x + item.width);
  }
  const box = unionBox(
    items.map((item) => ({
      text: item.text,
      x: item.x,
      top: item.top,
      width: item.width,
      height: item.height,
      fontSize: item.fontSize,
      column: 0,
    })),
  );
  return {
    text: text.replace(/[ \t]+\n/gu, '\n').trim(),
    x: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    fontSize: Math.max(...items.map((item) => item.fontSize)),
    column: 0,
  };
}

function orderLines(lines: PdfLayoutLine[], pageWidth: number): PdfLayoutLine[] {
  const split = detectColumnSplit(lines, pageWidth);
  if (split === null) {
    return [...lines].sort((left, right) => left.top - right.top || left.x - right.x);
  }

  const tagged = lines.map((line) => ({
    ...line,
    column: line.x + line.width <= split ? 0 : line.x >= split ? 1 : 2,
  }));
  const spanning = tagged
    .filter((line) => line.column === 2)
    .sort((left, right) => left.top - right.top || left.x - right.x);
  const ordered: PdfLayoutLine[] = [];
  let top = Number.NEGATIVE_INFINITY;
  for (const boundary of [...spanning, null]) {
    const bottom = boundary?.top ?? Number.POSITIVE_INFINITY;
    const band = tagged.filter((line) => line.column !== 2 && line.top >= top && line.top < bottom);
    ordered.push(
      ...band.sort(
        (left, right) => left.column - right.column || left.top - right.top || left.x - right.x,
      ),
    );
    if (boundary) ordered.push(boundary);
    top = boundary ? boundary.top + boundary.height : bottom;
  }
  return ordered;
}

function detectColumnSplit(lines: PdfLayoutLine[], pageWidth: number): number | null {
  if (lines.length < 6) return null;
  let best: { split: number; score: number } | null = null;
  for (const ratio of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65]) {
    const split = pageWidth * ratio;
    let left = 0;
    let right = 0;
    let crossing = 0;
    for (const line of lines) {
      if (line.width >= pageWidth * 0.75) {
        crossing += 1;
      } else if (line.x + line.width <= split) {
        left += 1;
      } else if (line.x >= split) {
        right += 1;
      } else {
        crossing += 1;
      }
    }
    if (left < 3 || right < 3) continue;
    const score = Math.min(left, right) - crossing * 2;
    if (!best || score > best.score) best = { split, score };
  }
  return best && best.score > 0 ? best.split : null;
}

function marginRole(line: PdfLayoutLine, pageHeight: number): 'header' | 'footer' | null {
  if (line.top <= pageHeight * 0.12) return 'header';
  if (line.top + line.height >= pageHeight * 0.88) return 'footer';
  return null;
}

function marginFingerprint(text: string): string {
  return text.toLocaleLowerCase().replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();
}

function isObviousPageNumber(text: string, role: 'header' | 'footer'): boolean {
  return role === 'footer' && /^(?:page\s*)?\d+(?:\s*(?:of|\/)\s*\d+)?$/iu.test(text.trim());
}

function headingLevel(line: PdfLayoutLine, bodyFontSize: number): number | null {
  const text = line.text.trim();
  if (!text || text.length > 160 || text.includes('\t')) return null;
  const ratio = line.fontSize / Math.max(1, bodyFontSize);
  const numberedHeading =
    /^(?:第[一二三四五六七八九十百千\d]+[章节篇]|(?:\d+\.){0,3}\d+\s+\S+)/u.test(text);
  if (ratio >= 1.5) return 1;
  if (ratio >= 1.25) return 2;
  if (ratio >= 1.12 || numberedHeading) return 3;
  return null;
}

function canJoinParagraph(
  previous: PdfLayoutLine,
  current: PdfLayoutLine,
  bodyFontSize: number,
): boolean {
  if (previous.column !== current.column) return false;
  const verticalGap = current.top - (previous.top + previous.height);
  if (verticalGap < -bodyFontSize) return false;
  if (verticalGap > bodyFontSize * 1.8) return false;
  return Math.abs(previous.x - current.x) <= bodyFontSize * 3 || current.column === 0;
}

function joinParagraphLines(lines: PdfLayoutLine[]): string {
  return lines.reduce((text, line) => {
    if (!text) return line.text;
    if (text.endsWith('-') && /^\p{Letter}/u.test(line.text))
      return `${text.slice(0, -1)}${line.text}`;
    return `${text}${text.endsWith('\t') || line.text.startsWith('\t') ? '' : ' '}${line.text}`;
  }, '');
}

function unionBox(
  lines: Array<Pick<PdfLayoutLine, 'x' | 'top' | 'width' | 'height'>>,
): BoundingBox {
  const first = lines[0];
  if (!first) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...lines.map((line) => line.x));
  const top = Math.min(...lines.map((line) => line.top));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const bottom = Math.max(...lines.map((line) => line.top + line.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function normalizedBox(box: BoundingBox, pageWidth: number, pageHeight: number): BoundingBox {
  return {
    x: clamp(box.x / Math.max(1, pageWidth), 0, 1),
    y: clamp(box.y / Math.max(1, pageHeight), 0, 1),
    width: clamp(box.width / Math.max(1, pageWidth), 0, 1),
    height: clamp(box.height / Math.max(1, pageHeight), 0, 1),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return 0;
  if (sorted.length % 2 === 1) return value;
  return ((sorted[middle - 1] ?? value) + value) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
