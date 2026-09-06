import { PDFParse } from 'pdf-parse';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult, SourceAnchor } from '../index';
import type {
  DocumentQualityReport,
  PdfOcrEngine,
  PdfPageClassification,
  PdfVisionEngine,
  StructuredDocument,
  StructuredDocumentElement,
  StructuredDocumentPage,
  StructuredDocumentTable,
} from '../structured-document';
import {
  createNativePageElements,
  extractPdfLayout,
  markRepeatedMargins,
  type PdfLayoutPage,
} from './pdf-layout';
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

export type PdfParserOptions = {
  ocrEngine?: PdfOcrEngine;
  ocrMaxPages?: number;
  ocrRenderWidth?: number;
  ocrTimeoutMs?: number;
  ocrMinConfidence?: number;
  nativeTextMinCharacters?: number;
  headerFooterMinPageRatio?: number;
  visionEngine?: PdfVisionEngine;
  visionMaxImages?: number;
  visionMinPixels?: number;
  visionTimeoutMs?: number;
  visionRequiredForMixedPages?: boolean;
  qualityMinScore?: number;
};

type PageImage = {
  id: string;
  filename: string;
  markdown: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
};

type ExtractedImages = {
  assets: ParsedAsset[];
  byPage: Map<number, PageImage[]>;
};

export class PdfDocumentParser implements DocumentParser {
  readonly name = 'pdf-layout';
  readonly version = '3.0.0';

  private readonly options: Required<Omit<PdfParserOptions, 'ocrEngine' | 'visionEngine'>> &
    Pick<PdfParserOptions, 'ocrEngine' | 'visionEngine'>;

  constructor(options: PdfParserOptions = {}) {
    this.options = {
      ocrEngine: options.ocrEngine,
      ocrMaxPages: options.ocrMaxPages ?? 100,
      ocrRenderWidth: options.ocrRenderWidth ?? 1_800,
      ocrTimeoutMs: options.ocrTimeoutMs ?? 120_000,
      ocrMinConfidence: options.ocrMinConfidence ?? 40,
      nativeTextMinCharacters: options.nativeTextMinCharacters ?? 40,
      headerFooterMinPageRatio: options.headerFooterMinPageRatio ?? 0.6,
      visionEngine: options.visionEngine,
      visionMaxImages: options.visionMaxImages ?? 50,
      visionMinPixels: options.visionMinPixels ?? 40_000,
      visionTimeoutMs: options.visionTimeoutMs ?? 90_000,
      visionRequiredForMixedPages: options.visionRequiredForMixedPages ?? false,
      qualityMinScore: options.qualityMinScore ?? 75,
    };
  }

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension ? extension === 'pdf' : input.mimeType.toLowerCase() === 'application/pdf';
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported PDF format');
    if (input.bytes.byteLength === 0) throw new Error('PDF file is empty');

    const parser = new PDFParse({ data: input.bytes.slice() });
    const warnings: string[] = [];
    try {
      const infoResult = await withTimeout(
        parser.getInfo(),
        PARSE_TIMEOUT_MS,
        'PDF metadata extraction timed out after 60 seconds',
      );
      if (infoResult.total > MAX_PDF_PAGES) {
        throw new Error(`PDF exceeds the ${MAX_PDF_PAGES}-page limit`);
      }

      const layoutPages = await this.extractLayoutWithFallback(
        parser,
        input,
        infoResult.total,
        warnings,
      );
      const images = await this.extractImages(parser, warnings);
      const tables = await this.extractTables(parser, warnings);
      markRepeatedMargins(layoutPages, this.options.headerFooterMinPageRatio);

      const pages = this.createPages(layoutPages, images.byPage);
      await this.applyOcr(parser, pages, warnings);
      this.attachTables(pages, tables);
      this.attachImages(pages, images.byPage);
      await this.applyVision(pages, images.byPage, warnings, input);

      const rendered = renderDocument(pages);
      if (!pages.some((page) => page.elements.some((element) => element.text.trim()))) {
        throw new Error('Parsed PDF document is empty');
      }

      const structure: StructuredDocument = {
        version: 1,
        format: 'pdf',
        pages,
        tables,
        quality: buildQualityReport(
          pages,
          warnings,
          this.options.ocrMinConfidence,
          this.options.visionRequiredForMixedPages,
          this.options.qualityMinScore,
        ),
      };
      return {
        markdown: rendered.markdown,
        anchors: rendered.anchors,
        assets: images.assets,
        warnings,
        structure,
        stats: {
          characters: rendered.markdown.length,
          pages: pages.length,
          scannedPages: pages.filter((page) => page.classification === 'scanned').length,
          mixedPages: pages.filter((page) => page.classification === 'mixed').length,
          ocrPages: pages.filter((page) => page.ocrApplied).length,
          tables: tables.length,
        },
      };
    } finally {
      await parser.destroy();
    }
  }

  private async extractLayoutWithFallback(
    parser: PDFParse,
    input: ParseInput,
    totalPages: number,
    warnings: string[],
  ): Promise<PdfLayoutPage[]> {
    try {
      return await withTimeout(
        extractPdfLayout(input.bytes),
        PARSE_TIMEOUT_MS,
        'PDF layout extraction timed out after 60 seconds',
      );
    } catch (error) {
      warnings.push(`PDF layout extraction degraded to plain text: ${errorMessage(error)}`);
      const textResult = await withTimeout(
        parser.getText({ lineEnforce: true, cellSeparator: '\t' }),
        PARSE_TIMEOUT_MS,
        'PDF text extraction timed out after 60 seconds',
      );
      const textByPage = new Map(
        textResult.pages.map((page) => [page.num, cleanMarkdown(page.text)]),
      );
      return Array.from({ length: totalPages }, (_, index) => {
        const page = index + 1;
        const text = textByPage.get(page) ?? '';
        return {
          page,
          width: 1,
          height: 1,
          textCharacters: text.replace(/\s+/gu, '').length,
          textCoverage: text ? 0.1 : 0,
          lines: text
            ? [
                {
                  text,
                  x: 0,
                  top: 0,
                  width: 1,
                  height: 1,
                  fontSize: 1,
                  column: 0,
                },
              ]
            : [],
        };
      });
    }
  }

  private createPages(
    layoutPages: PdfLayoutPage[],
    imagesByPage: Map<number, PageImage[]>,
  ): StructuredDocumentPage[] {
    const sectionPath: string[] = [];
    return layoutPages.map((layout) => {
      const bodyTextCharacters = layout.lines
        .filter((line) => !line.marginRole)
        .reduce((sum, line) => sum + line.text.replace(/\s+/gu, '').length, 0);
      const imageCount = imagesByPage.get(layout.page)?.length ?? 0;
      return {
        page: layout.page,
        width: layout.width,
        height: layout.height,
        classification: classifyPdfPage(
          bodyTextCharacters,
          imageCount,
          this.options.nativeTextMinCharacters,
        ),
        textCharacters: bodyTextCharacters,
        textCoverage: layout.textCoverage,
        imageCount,
        ocrApplied: false,
        visionAnalyzedImages: 0,
        elements: createNativePageElements(layout, sectionPath),
      };
    });
  }

  private async applyOcr(
    parser: PDFParse,
    pages: StructuredDocumentPage[],
    warnings: string[],
  ): Promise<void> {
    const scannedPages = pages.filter((page) => page.classification === 'scanned');
    if (scannedPages.length === 0) return;
    if (!this.options.ocrEngine) {
      warnings.push(`Detected ${scannedPages.length} scanned PDF page(s), but PDF OCR is disabled`);
      return;
    }
    if (scannedPages.length > this.options.ocrMaxPages) {
      throw new Error(
        `PDF requires OCR for ${scannedPages.length} pages, exceeding the configured ${this.options.ocrMaxPages}-page OCR limit`,
      );
    }

    const screenshots = await withTimeout(
      parser.getScreenshot({
        partial: scannedPages.map((page) => page.page),
        desiredWidth: this.options.ocrRenderWidth,
        imageBuffer: true,
        imageDataUrl: false,
      }),
      this.options.ocrTimeoutMs * scannedPages.length,
      'PDF page rendering for OCR timed out',
    );
    const screenshotByPage = new Map(
      screenshots.pages.map((screenshot) => [screenshot.pageNumber, screenshot]),
    );

    for (const page of scannedPages) {
      const screenshot = screenshotByPage.get(page.page);
      if (!screenshot?.data.byteLength) {
        warnings.push(`PDF page ${page.page} could not be rendered for OCR`);
        continue;
      }
      try {
        const result = await withTimeout(
          this.options.ocrEngine.recognize({
            page: page.page,
            image: screenshot.data,
            width: screenshot.width,
            height: screenshot.height,
          }),
          this.options.ocrTimeoutMs,
          `PDF page ${page.page} OCR timed out`,
        );
        const blocks = result.blocks.length
          ? result.blocks
          : result.text.trim()
            ? [{ text: result.text, confidence: result.confidence }]
            : [];
        const retainedMargins = page.elements.filter(
          (element) => element.kind === 'header' || element.kind === 'footer',
        );
        page.elements = [
          ...retainedMargins,
          ...blocks
            .filter((block) => block.text.trim())
            .map((block, index): StructuredDocumentElement => ({
              id: `p${page.page}-ocr-${index + 1}`,
              kind: 'paragraph',
              page: page.page,
              order: retainedMargins.length + index + 1,
              text: cleanMarkdown(block.text),
              markdown: cleanMarkdown(block.text),
              offsetStart: 0,
              offsetEnd: 0,
              searchable: true,
              source: 'ocr',
              sectionPath: [],
              bbox: block.bbox,
              confidence: block.confidence,
            })),
        ];
        page.ocrApplied = true;
        page.ocrConfidence = result.confidence;
        if (result.confidence < this.options.ocrMinConfidence) {
          warnings.push(
            `PDF page ${page.page} OCR confidence ${result.confidence.toFixed(1)} is below ${this.options.ocrMinConfidence}`,
          );
        }
      } catch (error) {
        warnings.push(`PDF page ${page.page} OCR failed: ${errorMessage(error)}`);
      }
    }
  }

  private async extractImages(parser: PDFParse, warnings: string[]): Promise<ExtractedImages> {
    const assets: ParsedAsset[] = [];
    const byPage = new Map<number, PageImage[]>();
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
        let ordinal = 0;
        for (const image of page.images) {
          if (!image.data?.byteLength) continue;
          ordinal += 1;
          if (assets.length >= MAX_EMBEDDED_IMAGES) {
            warnings.push('Skipped remaining PDF images: document exceeds 500 images');
            return { assets, byPage };
          }
          if (image.data.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
            warnings.push(
              `Skipped PDF page ${page.pageNumber} image ${ordinal}: image exceeds 10 MB`,
            );
            continue;
          }
          if (totalBytes + image.data.byteLength > MAX_TOTAL_IMAGE_BYTES) {
            warnings.push('Skipped remaining PDF images: total image data exceeds 50 MB');
            return { assets, byPage };
          }
          totalBytes += image.data.byteLength;
          const mimeType = sniffImageMimeType(image.data);
          const filename = `pdf-image-p${page.pageNumber}-${String(ordinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
          const pageImages = byPage.get(page.pageNumber) ?? [];
          pageImages.push({
            id: `p${page.pageNumber}-f${ordinal}`,
            filename,
            markdown: `![PDF page ${page.pageNumber} image ${ordinal}](${assetReference(filename)})`,
            mimeType,
            bytes: image.data,
            width: image.width,
            height: image.height,
          });
          byPage.set(page.pageNumber, pageImages);
          assets.push({
            kind: 'image',
            filename,
            mimeType,
            bytes: image.data,
            anchor: { type: 'page', page: page.pageNumber },
          });
        }
      }
    } catch (error) {
      warnings.push(`PDF image extraction skipped: ${errorMessage(error)}`);
    }
    return { assets, byPage };
  }

  private async extractTables(
    parser: PDFParse,
    warnings: string[],
  ): Promise<StructuredDocumentTable[]> {
    try {
      const tableResult = await withTimeout(
        parser.getTable(),
        PARSE_TIMEOUT_MS,
        'PDF table extraction timed out after 60 seconds',
      );
      return tableResult.pages.flatMap((page) =>
        page.tables.flatMap((rows, index) => {
          const markdown = toMarkdownTable(rows);
          if (!markdown) return [];
          return [
            {
              id: `p${page.num}-t${index + 1}`,
              page: page.num,
              rows,
              markdown,
            },
          ];
        }),
      );
    } catch (error) {
      warnings.push(`PDF table extraction skipped: ${errorMessage(error)}`);
      return [];
    }
  }

  private attachTables(pages: StructuredDocumentPage[], tables: StructuredDocumentTable[]): void {
    for (const table of tables) {
      const page = pages.find((candidate) => candidate.page === table.page);
      if (!page) continue;
      const tableTerms = new Set(
        table.rows
          .flat()
          .flatMap((cell) => normalizedTerms(cell))
          .filter(Boolean),
      );
      for (const element of page.elements) {
        if (element.kind !== 'paragraph' || tableTerms.size === 0) continue;
        const elementTerms = normalizedTerms(element.text);
        const matching = elementTerms.filter((term) => tableTerms.has(term)).length;
        if (elementTerms.length > 0 && matching / elementTerms.length >= 0.65) {
          element.searchable = false;
        }
      }
      const order = Math.max(0, ...page.elements.map((element) => element.order)) + 1;
      const sectionPath =
        [...page.elements]
          .reverse()
          .find((element) => element.searchable && element.sectionPath.length > 0)?.sectionPath ??
        [];
      page.elements.push({
        id: table.id,
        kind: 'table',
        page: table.page,
        order,
        text: table.rows.map((row) => row.join(' | ')).join('\n'),
        markdown: `### Table ${tablesForPage(tables, table.page).indexOf(table) + 1}\n\n${table.markdown}`,
        offsetStart: 0,
        offsetEnd: 0,
        searchable: true,
        source: 'derived',
        sectionPath: [...sectionPath],
        tableId: table.id,
      });
    }
  }

  private attachImages(
    pages: StructuredDocumentPage[],
    imagesByPage: Map<number, PageImage[]>,
  ): void {
    for (const page of pages) {
      for (const image of imagesByPage.get(page.page) ?? []) {
        const order = Math.max(0, ...page.elements.map((element) => element.order)) + 1;
        const sectionPath =
          [...page.elements]
            .reverse()
            .find((element) => element.searchable && element.sectionPath.length > 0)?.sectionPath ??
          [];
        page.elements.push({
          id: image.id,
          kind: 'figure',
          page: page.page,
          order,
          text: `PDF page ${page.page} image`,
          markdown: image.markdown,
          offsetStart: 0,
          offsetEnd: 0,
          searchable: false,
          source: 'derived',
          sectionPath: [...sectionPath],
          figureId: image.id,
          assetFilename: image.filename,
        });
      }
    }
  }

  private async applyVision(
    pages: StructuredDocumentPage[],
    imagesByPage: Map<number, PageImage[]>,
    warnings: string[],
    input: ParseInput,
  ): Promise<void> {
    if (!this.options.visionEngine) return;
    const candidates = pages.flatMap((page) =>
      (imagesByPage.get(page.page) ?? [])
        .filter((image) => image.width * image.height >= this.options.visionMinPixels)
        .map((image) => ({ page, image })),
    );
    for (const { page, image } of candidates.slice(0, this.options.visionMaxImages)) {
      const element = page.elements.find((candidate) => candidate.figureId === image.id);
      if (!element) continue;
      try {
        const result = await withTimeout(
          this.options.visionEngine.analyze({
            page: page.page,
            image: image.bytes,
            mimeType: image.mimeType,
            width: image.width,
            height: image.height,
            nearbyText: page.elements
              .filter((candidate) => candidate.searchable && candidate.kind !== 'figure')
              .map((candidate) => candidate.text)
              .join('\n')
              .slice(0, 2_000),
            tenantId: input.tenantId,
            runId: input.documentVersionId,
          }),
          this.options.visionTimeoutMs,
          `PDF page ${page.page} image analysis timed out`,
        );
        page.visionAnalyzedImages += 1;
        element.kind = result.kind === 'table' ? 'table' : 'figure';
        element.text = result.description.trim();
        element.markdown = `${image.markdown}\n\n> Visual analysis: ${result.description.trim()}`;
        element.searchable = result.searchable && Boolean(result.description.trim());
        element.source = 'vision';
        element.confidence = result.confidence;
      } catch (error) {
        warnings.push(
          `PDF page ${page.page} image ${image.filename} analysis failed: ${errorMessage(error)}`,
        );
      }
    }
    if (candidates.length > this.options.visionMaxImages) {
      warnings.push(
        `Skipped ${candidates.length - this.options.visionMaxImages} PDF images beyond the configured vision limit`,
      );
    }
  }
}

export function classifyPdfPage(
  textCharacters: number,
  imageCount: number,
  nativeTextMinCharacters = 40,
): PdfPageClassification {
  if (textCharacters < nativeTextMinCharacters) return 'scanned';
  return imageCount > 0 ? 'mixed' : 'native';
}

function renderDocument(pages: StructuredDocumentPage[]): {
  markdown: string;
  anchors: SourceAnchor[];
} {
  let markdown = '';
  const anchors: SourceAnchor[] = [];
  const append = (value: string) => {
    markdown += value;
  };

  for (const page of pages) {
    if (markdown) append('\n\n');
    const pageStart = markdown.length;
    append(`## Page ${page.page}`);
    for (const element of [...page.elements].sort(
      (left, right) => left.order - right.order || left.id.localeCompare(right.id),
    )) {
      if (!element.markdown.trim()) continue;
      append('\n\n');
      element.offsetStart = markdown.length;
      append(element.markdown.trim());
      element.offsetEnd = markdown.length;
      anchors.push({
        type: 'page',
        page: page.page,
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
      });
    }
    anchors.push({
      type: 'page',
      page: page.page,
      offsetStart: pageStart,
      offsetEnd: markdown.length,
    });
  }
  return { markdown: cleanMarkdown(markdown), anchors };
}

function tablesForPage(tables: StructuredDocumentTable[], page: number): StructuredDocumentTable[] {
  return tables.filter((table) => table.page === page);
}

function normalizedTerms(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter((term) => term.length > 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildQualityReport(
  pages: StructuredDocumentPage[],
  warnings: string[],
  minimumOcrConfidence: number,
  visionRequiredForMixedPages: boolean,
  minimumScore: number,
): DocumentQualityReport {
  const scannedPages = pages.filter((page) => page.classification === 'scanned');
  const unprocessedScannedPages = scannedPages.filter((page) => !page.ocrApplied).length;
  const lowConfidenceOcrPages = scannedPages.filter(
    (page) => page.ocrApplied && (page.ocrConfidence ?? 0) < minimumOcrConfidence,
  ).length;
  const emptySearchablePages = pages.filter(
    (page) => !page.elements.some((element) => element.searchable && element.text.trim()),
  ).length;
  const unanalyzedVisuals = pages.reduce(
    (sum, page) => sum + Math.max(0, page.imageCount - page.visionAnalyzedImages),
    0,
  );
  const reasons: string[] = [];
  if (unprocessedScannedPages > 0) {
    reasons.push(`${unprocessedScannedPages} scanned page(s) were not processed by OCR`);
  }
  if (lowConfidenceOcrPages > 0) {
    reasons.push(`${lowConfidenceOcrPages} OCR page(s) are below the confidence threshold`);
  }
  if (emptySearchablePages > 0) {
    reasons.push(`${emptySearchablePages} page(s) contain no searchable content`);
  }
  if (visionRequiredForMixedPages && unanalyzedVisuals > 0) {
    reasons.push(`${unanalyzedVisuals} visual element(s) were not analyzed`);
  }
  if (warnings.some((warning) => /degraded|failed/iu.test(warning))) {
    reasons.push('One or more parsing stages degraded or failed');
  }
  const score = Math.max(
    0,
    100 -
      unprocessedScannedPages * 35 -
      lowConfidenceOcrPages * 20 -
      emptySearchablePages * 25 -
      (visionRequiredForMixedPages ? Math.min(30, unanalyzedVisuals * 5) : 0) -
      (warnings.length > 0 ? Math.min(15, warnings.length * 3) : 0),
  );
  return {
    status: score >= minimumScore && reasons.length === 0 ? 'pass' : 'review',
    score,
    reasons,
    scannedPages: scannedPages.length,
    unprocessedScannedPages,
    lowConfidenceOcrPages,
    emptySearchablePages,
    unanalyzedVisuals,
  };
}
