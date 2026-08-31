import type JSZip from 'jszip';
import { parseOffice } from 'officeparser';
import type { DocumentParser, ParseInput, ParseResult, SourceAnchor } from '../index';
import { cleanMarkdown, extensionOf, headingAnchors } from './plain-text';
import { loadOfficePackage, readZipText } from './office-package';
import { ParserLimitError, toMarkdownTable, withTimeout } from './parser-utils';

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_PPTX_SLIDES = 500;
const MAX_SLIDE_XML_BYTES = 10 * 1024 * 1024;
const MAX_PPTX_TABLE_CELLS = 250_000;
const MAX_MARKDOWN_CHARACTERS = 5_000_000;
const PARSE_TIMEOUT_MS = 60_000;

type SlideSection = { markdown: string; slide: number };
type SlideParagraph = { text: string; list: boolean; level: number };

export class PptxDocumentParser implements DocumentParser {
  readonly name = 'pptx-ooxml-officeparser';
  readonly version = '1.0.0';

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension ? extension === 'pptx' : input.mimeType.toLowerCase() === PPTX_MIME_TYPE;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported PPTX format');
    if (input.bytes.byteLength === 0) throw new Error('PPTX file is empty');

    const packageInfo = await loadPresentationPackage(input.bytes);
    try {
      return await parsePptxPackage(packageInfo.zip, packageInfo.slidePaths);
    } catch (error) {
      if (error instanceof ParserLimitError) throw error;
      return parseWithOfficeParser(input.bytes, packageInfo.slidePaths.length, error);
    }
  }
}

async function loadPresentationPackage(
  bytes: Uint8Array,
): Promise<{ zip: JSZip; slidePaths: string[] }> {
  const zip = await loadOfficePackage(bytes, 'PPTX');
  const slidePaths = await orderedSlidePaths(zip);
  if (slidePaths.length === 0) throw new Error('PPTX package contains no slides');
  if (slidePaths.length > MAX_PPTX_SLIDES) {
    throw new ParserLimitError(`PPTX exceeds the ${MAX_PPTX_SLIDES}-slide limit`);
  }
  return { zip, slidePaths };
}

async function parsePptxPackage(zip: JSZip, slidePaths: string[]): Promise<ParseResult> {
  const sections: SlideSection[] = [];
  let tableCells = 0;
  for (const [index, path] of slidePaths.entries()) {
    const file = zip.file(path);
    if (!file) throw new Error(`PPTX slide entry is missing: ${path}`);
    const xml = await readZipText(file, 'PPTX', MAX_SLIDE_XML_BYTES);
    const parsed = parseSlideXml(xml, index + 1);
    tableCells += parsed.tableCells;
    if (tableCells > MAX_PPTX_TABLE_CELLS) {
      throw new ParserLimitError(`PPTX exceeds the ${MAX_PPTX_TABLE_CELLS}-table-cell limit`);
    }
    sections.push({ markdown: parsed.markdown, slide: index + 1 });
  }

  const { markdown, anchors } = joinSlideSections(sections);
  if (!markdown) throw new Error('Parsed PPTX document is empty');
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new ParserLimitError(`PPTX Markdown exceeds ${MAX_MARKDOWN_CHARACTERS} characters`);
  }
  return {
    markdown,
    anchors,
    assets: [],
    warnings: [],
    stats: { characters: markdown.length, slides: slidePaths.length },
  };
}

async function parseWithOfficeParser(
  bytes: Uint8Array,
  slideCount: number,
  primaryError: unknown,
): Promise<ParseResult> {
  try {
    const ast = await withTimeout(
      parseOffice(bytes, {
        fileType: 'pptx',
        extractAttachments: false,
        ignoreSlideMasters: true,
      }),
      PARSE_TIMEOUT_MS,
      'PPTX fallback parsing timed out after 60 seconds',
    );
    const converted = await withTimeout(
      ast.to('md'),
      PARSE_TIMEOUT_MS,
      'PPTX fallback Markdown conversion timed out after 60 seconds',
    );
    const markdown = cleanMarkdown(String(converted.value ?? ''));
    if (!markdown) throw new Error('officeparser returned empty Markdown');
    if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
      throw new ParserLimitError(`PPTX Markdown exceeds ${MAX_MARKDOWN_CHARACTERS} characters`);
    }
    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets: [],
      warnings: [`OOXML parsing failed; used officeparser fallback: ${errorMessage(primaryError)}`],
      stats: { characters: markdown.length, slides: slideCount },
    };
  } catch (fallbackError) {
    if (fallbackError instanceof ParserLimitError) throw fallbackError;
    throw new Error(
      `PPTX parsing failed (OOXML: ${errorMessage(primaryError)}; officeparser: ${errorMessage(fallbackError)})`,
    );
  }
}

async function orderedSlidePaths(zip: JSZip): Promise<string[]> {
  const presentation = zip.file('ppt/presentation.xml');
  const relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && relationships) {
    const presentationXml = await readZipText(presentation, 'PPTX', MAX_SLIDE_XML_BYTES);
    const relationshipsXml = await readZipText(relationships, 'PPTX', MAX_SLIDE_XML_BYTES);
    const targets = new Map<string, string>();
    for (const relationship of relationshipsXml.matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)) {
      const attributes = relationship[1] ?? '';
      const id = attribute(attributes, 'Id');
      const target = attribute(attributes, 'Target');
      const type = attribute(attributes, 'Type');
      if (id && target && /\/slide$/i.test(type ?? '')) {
        targets.set(id, normalizePresentationTarget(target));
      }
    }
    const ordered = [...presentationXml.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"[^>]*\/?\s*>/gi)]
      .map((match) => targets.get(match[1] ?? ''))
      .filter((path): path is string => Boolean(path && zip.file(path)));
    if (ordered.length > 0) return ordered;
  }

  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
}

function parseSlideXml(
  xml: string,
  slideNumberValue: number,
): { markdown: string; tableCells: number } {
  const tables = extractTables(xml);
  const xmlWithoutTables = xml.replace(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi, '');
  const shapes = xmlWithoutTables.match(/<p:sp\b[\s\S]*?<\/p:sp>/gi) ?? [];
  const titles: string[] = [];
  const body: SlideParagraph[] = [];
  for (const shape of shapes) {
    if (isAuxiliaryShape(shape)) continue;
    const paragraphs = extractParagraphs(shape);
    if (paragraphs.length === 0) continue;
    if (isTitleShape(shape)) {
      const title = paragraphs
        .map((paragraph) => paragraph.text)
        .join(' ')
        .trim();
      if (title) titles.push(title);
    } else {
      body.push(...paragraphs);
    }
  }

  const titleSet = new Set(titles.map(normalizeText));
  const lines = [`## Slide ${slideNumberValue}`];
  for (const title of titles) lines.push('', `### ${title}`);
  const bodyLines = body
    .filter((paragraph) => !titleSet.has(normalizeText(paragraph.text)))
    .map((paragraph) => {
      if (!paragraph.list) return paragraph.text;
      return `${'  '.repeat(paragraph.level)}- ${paragraph.text}`;
    });
  if (bodyLines.length > 0) lines.push('', ...bodyLines);
  for (const [index, table] of tables.entries()) {
    const markdown = toMarkdownTable(table);
    if (markdown) lines.push('', `### Table ${index + 1}`, '', markdown);
  }

  return {
    markdown: cleanMarkdown(lines.join('\n')),
    tableCells: tables.reduce(
      (total, table) => total + table.reduce((cells, row) => cells + row.length, 0),
      0,
    ),
  };
}

function extractParagraphs(xml: string): SlideParagraph[] {
  const paragraphs: SlideParagraph[] = [];
  for (const match of xml.matchAll(/<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/gi)) {
    const block = match[0];
    const text = extractRunsText(block).trim();
    if (!text) continue;
    const properties = block.match(/<a:pPr\b([^>]*)>/i);
    const level = Math.max(0, Number(attribute(properties?.[1] ?? '', 'lvl') ?? 0));
    paragraphs.push({
      text,
      list: /<a:(?:buChar|buAutoNum)\b/i.test(block),
      level: Number.isFinite(level) ? level : 0,
    });
  }
  return paragraphs;
}

function isTitleShape(shape: string): boolean {
  const placeholder = shape.match(/<p:ph\b([^>]*)>/i);
  const placeholderType = attribute(placeholder?.[1] ?? '', 'type');
  if (/^(?:ctrTitle|title)$/i.test(placeholderType ?? '')) return true;
  const properties = shape.match(/<p:cNvPr\b([^>]*)>/i);
  const name = attribute(properties?.[1] ?? '', 'name') ?? '';
  if (/(?:subtitle|eyebrow|footer|slide[\s_-]*number)/i.test(name)) return false;
  return /(?:^|[\s_-])(?:title|titel|titre|标题)(?:$|[\s_-])/i.test(name);
}

function isAuxiliaryShape(shape: string): boolean {
  const placeholder = shape.match(/<p:ph\b([^>]*)>/i);
  const placeholderType = attribute(placeholder?.[1] ?? '', 'type');
  if (/^(?:dt|ftr|sldNum)$/i.test(placeholderType ?? '')) return true;
  const properties = shape.match(/<p:cNvPr\b([^>]*)>/i);
  const name = attribute(properties?.[1] ?? '', 'name') ?? '';
  return /(?:^|[\s_-])(?:footer|slide[\s_-]*number)(?:$|[\s_-])/i.test(name);
}

function extractTables(xml: string): string[][][] {
  const tables: string[][][] = [];
  for (const tableMatch of xml.matchAll(/<a:tbl\b[\s\S]*?<\/a:tbl>/gi)) {
    const rows: string[][] = [];
    for (const rowMatch of tableMatch[0].matchAll(/<a:tr\b[\s\S]*?<\/a:tr>/gi)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[0].matchAll(/<a:tc\b[\s\S]*?<\/a:tc>/gi)) {
        const cell = cellMatch[0];
        const mergedContinuation = /<a:tcPr\b[^>]*\b(?:hMerge|vMerge)="1"/i.test(cell);
        const text = mergedContinuation
          ? ''
          : extractParagraphs(cell)
              .map((paragraph) => paragraph.text)
              .join(' ')
              .trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

function extractRunsText(xml: string): string {
  let text = '';
  for (const match of xml.matchAll(/<a:br\s*\/>|<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)) {
    text += /^<a:br/i.test(match[0]) ? '\n' : decodeXml(match[1] ?? '');
  }
  return text;
}

function joinSlideSections(sections: SlideSection[]): {
  markdown: string;
  anchors: SourceAnchor[];
} {
  const markdown = sections.map((section) => section.markdown).join('\n\n');
  const anchors: SourceAnchor[] = [];
  let offset = 0;
  for (const section of sections) {
    anchors.push({
      type: 'slide',
      slide: section.slide,
      offsetStart: offset,
      offsetEnd: offset + section.markdown.length,
    });
    offset += section.markdown.length + 2;
  }
  return { markdown, anchors };
}

function normalizePresentationTarget(target: string): string {
  const path = target.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.startsWith('/')) return path.slice(1);
  if (path.startsWith('../')) return path.replace(/^\.\.\//, '');
  return path.startsWith('ppt/') ? path : `ppt/${path}`;
}

function attribute(attributes: string, name: string): string | undefined {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i'));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

function decodeXml(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|lt|gt|amp|quot|apos);/gi,
    (entity, decimal, hex) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      const named: Record<string, string> = {
        '&amp;': '&',
        '&apos;': "'",
        '&gt;': '>',
        '&lt;': '<',
        '&quot;': '"',
      };
      return named[String(entity).toLowerCase()] ?? entity;
    },
  );
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
