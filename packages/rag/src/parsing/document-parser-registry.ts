import type { DocumentParser, ParsedDocument, ParseInput } from '../index';
import { DocxDocumentParser, type DocxParserOptions } from './docx';
import { PdfDocumentParser, type PdfParserOptions } from './pdf';
import { PlainTextDocumentParser, extensionOf } from './plain-text';
import { PptxDocumentParser, type PptxParserOptions } from './pptx';
import { XlsxDocumentParser, type XlsxParserOptions } from './xlsx';

export type DocumentParserRegistryOptions = {
  docx?: DocxParserOptions;
  pdf?: PdfParserOptions;
  pptx?: PptxParserOptions;
  xlsx?: XlsxParserOptions;
  parsers?: DocumentParser[];
};

export class DocumentParserRegistry {
  private readonly parsers: DocumentParser[];

  constructor(options: DocumentParserRegistryOptions = {}) {
    this.parsers = options.parsers ?? [
      new PlainTextDocumentParser(),
      new DocxDocumentParser(options.docx),
      new PdfDocumentParser(options.pdf),
      new XlsxDocumentParser(options.xlsx),
      new PptxDocumentParser(options.pptx),
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
