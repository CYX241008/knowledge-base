import type { DocumentParser, ParseInput, ParseResult, SourceAnchor } from '../index';
import type {
  DocumentLocation,
  StructuredDocument,
  StructuredDocumentElement,
} from '../structured-document';
import { createSectionedMarkdownStructure } from './structured-markdown';

const supportedExtensions = new Set(['txt', 'md', 'markdown']);
const supportedMimeTypes = new Set(['text/plain', 'text/markdown', 'text/x-markdown']);

export function cleanMarkdown(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  return index < 0 ? '' : filename.slice(index + 1).toLowerCase();
}

export function headingAnchors(markdown: string): SourceAnchor[] {
  const matches = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [{ type: 'document', offsetStart: 0, offsetEnd: markdown.length }];
  }

  return matches.map((match, index) => ({
    type: 'heading',
    heading: match[2]?.trim() ?? '',
    offsetStart: match.index,
    offsetEnd: matches[index + 1]?.index ?? markdown.length,
  }));
}

export class PlainTextDocumentParser implements DocumentParser {
  readonly name = 'plain-text';
  readonly version = '2.0.0';

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension
      ? supportedExtensions.has(extension)
      : supportedMimeTypes.has(input.mimeType.toLowerCase());
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    const extension = extensionOf(input.filename);
    if (!this.supports(input)) {
      throw new Error(`Unsupported plain text format: ${extension || input.mimeType}`);
    }

    const markdown = cleanMarkdown(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes));
    if (!markdown) throw new Error('Parsed document is empty');
    const format = isMarkdown(extension, input.mimeType) ? 'markdown' : 'text';

    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets: [],
      warnings: [],
      stats: { characters: markdown.length },
      structure:
        format === 'markdown'
          ? createSectionedMarkdownStructure(markdown, 'markdown')
          : createTextStructure(markdown),
    };
  }
}

function isMarkdown(extension: string, mimeType: string): boolean {
  return (
    extension === 'md' ||
    extension === 'markdown' ||
    mimeType.toLowerCase() === 'text/markdown' ||
    mimeType.toLowerCase() === 'text/x-markdown'
  );
}

function createTextStructure(markdown: string): StructuredDocument {
  const location: DocumentLocation = { type: 'document' };
  const elements = paragraphRanges(markdown).map((range, index): StructuredDocumentElement => ({
    id: `text-e${index + 1}`,
    kind: 'paragraph',
    location,
    order: index + 1,
    text: markdown.slice(range.start, range.end),
    markdown: markdown.slice(range.start, range.end),
    offsetStart: range.start,
    offsetEnd: range.end,
    searchable: true,
    source: 'native',
    sectionPath: [],
  }));
  return {
    version: 2,
    format: 'text',
    units: [{ id: 'document', location, elements }],
    tables: [],
    quality: {
      status: 'pass',
      score: 100,
      reasons: [],
      metrics: {
        units: 1,
        elements: elements.length,
        tables: 0,
      },
    },
  };
}

function paragraphRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let start: number | undefined;
  let cursor = 0;
  for (const match of markdown.matchAll(/.*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const lineStart = match.index;
    const lineEnd = lineStart + line.length;
    if (line.trim()) {
      start ??= lineStart;
      cursor = lineEnd;
      continue;
    }
    if (start !== undefined) {
      ranges.push(trimRange(markdown, start, cursor));
      start = undefined;
    }
    cursor = lineEnd;
  }
  if (start !== undefined) ranges.push(trimRange(markdown, start, markdown.length));
  return ranges.filter((range) => range.end > range.start);
}

function trimRange(content: string, start: number, end: number): { start: number; end: number } {
  while (start < end && /\s/u.test(content[start] ?? '')) start += 1;
  while (end > start && /\s/u.test(content[end - 1] ?? '')) end -= 1;
  return { start, end };
}
