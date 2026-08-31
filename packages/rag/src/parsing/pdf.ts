import { PDFParse } from 'pdf-parse';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult, SourceAnchor } from '../index';
import { cleanMarkdown, extensionOf } from './plain-text';
import {
  assetReference,
  extensionForMimeType,
  sniffImageMimeType,
  toMarkdownTable,
  withTimeout,
} from './parser-utils';

const MAX_PDF_PAGES = 500;
const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 500;
const PARSE_TIMEOUT_MS = 60_000;

type PageContent = { text: string; images: string[]; tables: string[] };

export class PdfDocumentParser implements DocumentParser {
  readonly name = 'pdf-parse';
  readonly version = '2.4.5';

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension ? extension === 'pdf' : input.mimeType.toLowerCase() === 'application/pdf';
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported PDF format');
    if (input.bytes.byteLength === 0) throw new Error('PDF file is empty');

    const parser = new PDFParse({ data: input.bytes });
    const warnings: string[] = [];
    const assets: ParsedAsset[] = [];
    try {
      const infoResult = await withTimeout(
        parser.getInfo(),
        PARSE_TIMEOUT_MS,
        'PDF metadata extraction timed out after 60 seconds',
      );
      if (infoResult.total > MAX_PDF_PAGES) {
        throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page limit`);
      }
      const textResult = await withTimeout(
        parser.getText(),
        PARSE_TIMEOUT_MS,
        'PDF text extraction timed out after 60 seconds',
      );
      const pageContent = new Map<number, PageContent>();
      for (let page = 1; page <= textResult.total; page += 1) {
        pageContent.set(page, { text: '', images: [], tables: [] });
      }
      for (const page of textResult.pages) {
        const content = pageContent.get(page.num);
        if (content) content.text = cleanMarkdown(page.text ?? '');
      }

      await this.extractImages(parser, pageContent, assets, warnings);
      await this.extractTables(parser, pageContent, warnings);

      const hasContent = [...pageContent.values()].some(
        (page) => page.text || page.images.length > 0 || page.tables.length > 0,
      );
      if (!hasContent) throw new Error('Parsed PDF document is empty');

      const sections: string[] = [];
      const anchors: SourceAnchor[] = [];
      let offset = 0;
      for (const [pageNumber, content] of pageContent) {
        const body = [content.text, ...content.images, ...content.tables]
          .filter(Boolean)
          .join('\n\n');
        const section = cleanMarkdown(`## Page ${pageNumber}${body ? `\n\n${body}` : ''}`);
        sections.push(section);
        anchors.push({
          type: 'page',
          page: pageNumber,
          offsetStart: offset,
          offsetEnd: offset + section.length,
        });
        offset += section.length + 2;
      }

      const markdown = sections.join('\n\n');
      return {
        markdown,
        anchors,
        assets,
        warnings,
        stats: { characters: markdown.length, pages: textResult.total },
      };
    } finally {
      await parser.destroy();
    }
  }

  private async extractImages(
    parser: PDFParse,
    pages: Map<number, PageContent>,
    assets: ParsedAsset[],
    warnings: string[],
  ): Promise<void> {
    let totalBytes = 0;
    try {
      const imageResult = await withTimeout(
        parser.getImage({
          imageThreshold: 50,
          imageBuffer: true,
          imageDataUrl: false,
        }),
        PARSE_TIMEOUT_MS,
        'PDF image extraction timed out after 60 seconds',
      );
      for (const page of imageResult.pages) {
        const content = pages.get(page.pageNumber);
        if (!content) continue;
        let ordinal = 0;
        for (const image of page.images) {
          if (!image.data?.byteLength) continue;
          ordinal += 1;
          if (assets.length >= MAX_EMBEDDED_IMAGES) {
            warnings.push('Skipped remaining PDF images: document exceeds 500 images');
            return;
          }
          if (image.data.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
            warnings.push(
              `Skipped PDF page ${page.pageNumber} image ${ordinal}: image exceeds 10 MB`,
            );
            continue;
          }
          if (totalBytes + image.data.byteLength > MAX_TOTAL_IMAGE_BYTES) {
            warnings.push('Skipped remaining PDF images: total image data exceeds 50 MB');
            return;
          }
          totalBytes += image.data.byteLength;
          const mimeType = sniffImageMimeType(image.data);
          const filename = `pdf-image-p${page.pageNumber}-${String(ordinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
          assets.push({
            kind: 'image',
            filename,
            mimeType,
            bytes: image.data,
            anchor: { type: 'page', page: page.pageNumber },
          });
          content.images.push(
            `![PDF page ${page.pageNumber} image ${ordinal}](${assetReference(filename)})`,
          );
        }
      }
    } catch (error) {
      warnings.push(`PDF image extraction skipped: ${errorMessage(error)}`);
    }
  }

  private async extractTables(
    parser: PDFParse,
    pages: Map<number, PageContent>,
    warnings: string[],
  ): Promise<void> {
    try {
      const tableResult = await withTimeout(
        parser.getTable(),
        PARSE_TIMEOUT_MS,
        'PDF table extraction timed out after 60 seconds',
      );
      for (const page of tableResult.pages) {
        const content = pages.get(page.num);
        if (!content) continue;
        page.tables.forEach((table, index) => {
          const markdown = toMarkdownTable(table);
          if (markdown) content.tables.push(`### Table ${index + 1}\n\n${markdown}`);
        });
      }
    } catch (error) {
      warnings.push(`PDF table extraction skipped: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
