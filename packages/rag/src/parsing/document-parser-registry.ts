import type { DocumentParser, ParsedDocument, ParseInput } from '../index';
import { DocxDocumentParser } from './docx';
import { PdfDocumentParser, type PdfParserOptions } from './pdf';
import { PlainTextDocumentParser, extensionOf } from './plain-text';
import { PptxDocumentParser } from './pptx';
import { XlsxDocumentParser } from './xlsx';

export type DocumentParserRegistryOptions = {
  pdf?: PdfParserOptions;
  parsers?: DocumentParser[];
};

export class DocumentParserRegistry {
  private readonly parsers: DocumentParser[];

  constructor(options: DocumentParserRegistryOptions = {}) {
    this.parsers = options.parsers ?? [
      new PlainTextDocumentParser(),
      new DocxDocumentParser(),
      new PdfDocumentParser(options.pdf),
      new XlsxDocumentParser(),
      new PptxDocumentParser(),
    ];
  }

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    return this.parsers.some((parser) => parser.supports(input));
  }

  async parse(input: ParseInput): Promise<ParsedDocument> {
    const parser = this.parsers.find((candidate) => candidate.supports(input));
    if (!parser) {
      const format = extensionOf(input.filename) || input.mimeType;
      throw new Error(`Unsupported document format: ${format}`);
    }
    const result = await parser.parse(input);
    return { ...result, parserName: parser.name, parserVersion: parser.version };
  }
}
