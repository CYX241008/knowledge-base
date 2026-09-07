import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type {
  DocumentFormat,
  DocumentLocation,
  StructuredDocument,
  StructuredDocumentElement,
  StructuredDocumentTable,
  StructuredDocumentUnit,
  StructuredElementKind,
} from '../structured-document';
import { ASSET_SCHEME } from './parser-utils';

export type StructuredMarkdownSection = {
  id: string;
  location: DocumentLocation;
  markdown: string;
  offsetStart: number;
};

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string;
  url?: string;
  depth?: number;
  children?: MarkdownNode[];
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
};

type MarkdownBlock = {
  kind: StructuredElementKind;
  text: string;
  markdown: string;
  offsetStart: number;
  offsetEnd: number;
  sectionPath: string[];
  rows?: string[][];
  assetFilename?: string;
};

export function createSectionedMarkdownStructure(
  markdown: string,
  format: Extract<DocumentFormat, 'markdown' | 'docx' | 'pptx' | 'xlsx'>,
  warnings: string[] = [],
): StructuredDocument {
  const units: StructuredDocumentUnit[] = [];
  const tables: StructuredDocumentTable[] = [];
  let currentUnit = createUnit('document', { type: 'document' });
  units.push(currentUnit);
  let elementOrdinal = 0;
  let tableOrdinal = 0;
  let figureOrdinal = 0;

  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind === 'heading') {
      currentUnit = createUnit(`section-${units.length}`, {
        type: 'section',
        heading: block.text,
      });
      units.push(currentUnit);
    }
    elementOrdinal += 1;
    const tableId = block.kind === 'table' ? `${format}-t${++tableOrdinal}` : undefined;
    const figureId = block.kind === 'figure' ? `${format}-f${++figureOrdinal}` : undefined;
    const element = createElement(
      `${format}-e${elementOrdinal}`,
      currentUnit.location,
      currentUnit.elements.length + 1,
      block,
      0,
      tableId,
      figureId,
    );
    currentUnit.elements.push(element);
    if (tableId) {
      tables.push({
        id: tableId,
        location: currentUnit.location,
        rows: block.rows ?? [],
        markdown: block.markdown,
      });
    }
  }

  return buildStructure(
    format,
    units.filter((unit) => unit.elements.length > 0),
    tables,
    warnings,
  );
}

export function createFixedUnitMarkdownStructure(
  format: Extract<DocumentFormat, 'pptx' | 'xlsx'>,
  sections: StructuredMarkdownSection[],
  warnings: string[] = [],
): StructuredDocument {
  const units: StructuredDocumentUnit[] = [];
  const tables: StructuredDocumentTable[] = [];
  for (const section of sections) {
    const unit = createUnit(section.id, section.location);
    let tableOrdinal = 0;
    let figureOrdinal = 0;
    for (const [index, block] of parseMarkdownBlocks(section.markdown).entries()) {
      const tableId = block.kind === 'table' ? `${section.id}-t${++tableOrdinal}` : undefined;
      const figureId = block.kind === 'figure' ? `${section.id}-f${++figureOrdinal}` : undefined;
      unit.elements.push(
        createElement(
          `${section.id}-e${index + 1}`,
          section.location,
          index + 1,
          block,
          section.offsetStart,
          tableId,
          figureId,
        ),
      );
      if (tableId) {
        tables.push({
          id: tableId,
          location: section.location,
          rows: block.rows ?? [],
          markdown: block.markdown,
        });
      }
    }
    units.push(unit);
  }
  return buildStructure(format, units, tables, warnings);
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: MarkdownBlock[] = [];
  const sectionPath: string[] = [];
  for (const node of tree.children as MarkdownNode[]) {
    const range = nodeRange(node, markdown);
    if (!range) continue;
    const rows = tableRows(node);
    const text = (
      rows.length > 0 ? rows.map((row) => row.join(' | ')).join('\n') : nodeText(node)
    ).trim();
    const rendered = markdown.slice(range.start, range.end);
    if (!text && !rendered.trim()) continue;
    if (node.type === 'heading') {
      const depth = Math.max(1, Math.min(6, node.depth ?? 1));
      const effectiveDepth = Math.min(depth, sectionPath.length + 1);
      sectionPath.splice(effectiveDepth - 1);
      sectionPath[effectiveDepth - 1] = text;
    }
    blocks.push({
      kind: markdownElementKind(node),
      text,
      markdown: rendered,
      offsetStart: range.start,
      offsetEnd: range.end,
      sectionPath: [...sectionPath],
      rows: rows.length > 0 ? rows : undefined,
      assetFilename: assetFilename(node),
    });
  }
  return blocks;
}

function createElement(
  id: string,
  location: DocumentLocation,
  order: number,
  block: MarkdownBlock,
  baseOffset: number,
  tableId?: string,
  figureId?: string,
): StructuredDocumentElement {
  return {
    id,
    kind: block.kind,
    location,
    order,
    text: block.text,
    markdown: block.markdown,
    offsetStart: baseOffset + block.offsetStart,
    offsetEnd: baseOffset + block.offsetEnd,
    searchable: isSearchable(block),
    source: 'native',
    sectionPath: block.sectionPath,
    tableId,
    figureId,
    assetFilename: block.assetFilename,
  };
}

function buildStructure(
  format: DocumentFormat,
  units: StructuredDocumentUnit[],
  tables: StructuredDocumentTable[],
  warnings: string[],
): StructuredDocument {
  const elements = units.reduce((sum, unit) => sum + unit.elements.length, 0);
  const reasons = warnings.map((warning) => warning.trim()).filter(Boolean);
  const score = Math.max(0, 100 - Math.min(40, reasons.length * 5));
  return {
    version: 2,
    format,
    units,
    tables,
    quality: {
      status: reasons.length > 0 ? 'review' : 'pass',
      score,
      reasons,
      metrics: {
        units: units.length,
        elements,
        tables: tables.length,
        warnings: reasons.length,
      },
    },
  };
}

function createUnit(id: string, location: DocumentLocation): StructuredDocumentUnit {
  return { id, location, elements: [] };
}

function markdownElementKind(node: MarkdownNode): StructuredElementKind {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'list':
      return 'list';
    case 'code':
      return 'code';
    case 'table':
      return 'table';
    default:
      return containsImage(node) ? 'figure' : 'paragraph';
  }
}

function isSearchable(block: MarkdownBlock): boolean {
  if (block.kind === 'figure') return Boolean(block.text.trim());
  return Boolean(block.text.trim() || block.markdown.trim());
}

function nodeRange(
  node: MarkdownNode,
  markdown: string,
): { start: number; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;
  let trimmedStart = Math.max(0, Math.min(start, markdown.length));
  let trimmedEnd = Math.max(trimmedStart, Math.min(end, markdown.length));
  while (trimmedStart < trimmedEnd && /\s/u.test(markdown[trimmedStart] ?? '')) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/u.test(markdown[trimmedEnd - 1] ?? '')) trimmedEnd -= 1;
  return trimmedEnd > trimmedStart ? { start: trimmedStart, end: trimmedEnd } : undefined;
}

function nodeText(node: MarkdownNode): string {
  if (typeof node.value === 'string') return node.value;
  if (node.type === 'image') return node.alt ?? '';
  if (!node.children?.length) return '';
  const separator =
    node.type === 'table' || node.type === 'tableRow'
      ? ' | '
      : node.type === 'list' || node.type === 'blockquote'
        ? '\n'
        : '';
  return node.children.map(nodeText).filter(Boolean).join(separator);
}

function tableRows(node: MarkdownNode): string[][] {
  if (node.type !== 'table') return [];
  return (node.children ?? [])
    .filter((row) => row.type === 'tableRow')
    .map((row) =>
      (row.children ?? [])
        .filter((cell) => cell.type === 'tableCell')
        .map((cell) => nodeText(cell).trim()),
    )
    .filter((row) => row.length > 0);
}

function containsImage(node: MarkdownNode): boolean {
  if (node.type === 'image') return true;
  return node.children?.some(containsImage) ?? false;
}

function assetFilename(node: MarkdownNode): string | undefined {
  if (node.type === 'image' && node.url?.startsWith(ASSET_SCHEME)) {
    try {
      return decodeURIComponent(node.url.slice(ASSET_SCHEME.length));
    } catch {
      return node.url.slice(ASSET_SCHEME.length);
    }
  }
  for (const child of node.children ?? []) {
    const filename = assetFilename(child);
    if (filename) return filename;
  }
  return undefined;
}
