import type { DocumentParser, ParseInput, ParseResult, SourceAnchor } from '../index';

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
  readonly version = '1.0.0';

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

    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets: [],
      warnings: [],
      stats: { characters: markdown.length },
    };
  }
}
