import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult } from '../index';
import type {
  DocumentProcessingObserver,
  OcrEngine,
  StructuredDocument,
  StructuredDocumentElement,
  VisionEngine,
} from '../structured-document';
import { cleanMarkdown, extensionOf, headingAnchors } from './plain-text';
import {
  assetReference,
  extensionForMimeType,
  imageDimensions,
  toMarkdownTable,
  withTimeout,
} from './parser-utils';
import { createSectionedMarkdownStructure } from './structured-markdown';

const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 500;
const PARSE_TIMEOUT_MS = 60_000;

export type DocxParserOptions = {
  ocrEngine?: OcrEngine;
  ocrMaxImages?: number;
  ocrMinPixels?: number;
  ocrTimeoutMs?: number;
  ocrMinConfidence?: number;
  ocrProvider?: string;
  visionEngine?: VisionEngine;
  visionMaxImages?: number;
  visionMinPixels?: number;
  visionTimeoutMs?: number;
  visionProvider?: string;
  visionModel?: string;
  onProcessingMetric?: DocumentProcessingObserver;
};

type ImageEnrichment = {
  marker: string;
  source: 'ocr' | 'vision';
  confidence?: number;
  kind?: 'figure';
  figureId?: string;
};

export class DocxDocumentParser implements DocumentParser {
  readonly name = 'mammoth-turndown';
  readonly version = '3.0.0';

  private readonly options: Required<
    Omit<DocxParserOptions, 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'>
  > &
    Pick<DocxParserOptions, 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'>;

  constructor(options: DocxParserOptions = {}) {
    this.options = {
      ocrEngine: options.ocrEngine,
      ocrMaxImages: options.ocrMaxImages ?? 100,
      ocrMinPixels: options.ocrMinPixels ?? 40_000,
      ocrTimeoutMs: options.ocrTimeoutMs ?? 120_000,
      ocrMinConfidence: options.ocrMinConfidence ?? 40,
      ocrProvider: options.ocrProvider ?? 'tesseract',
      visionEngine: options.visionEngine,
      visionMaxImages: options.visionMaxImages ?? 50,
      visionMinPixels: options.visionMinPixels ?? 40_000,
      visionTimeoutMs: options.visionTimeoutMs ?? 90_000,
      visionProvider: options.visionProvider ?? 'openai-compatible',
      visionModel: options.visionModel,
      onProcessingMetric: options.onProcessingMetric,
    };
  }

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension
      ? extension === 'docx'
      : input.mimeType.toLowerCase() ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported DOCX format');
    if (input.bytes.byteLength === 0) throw new Error('DOCX file is empty');

    const assets: ParsedAsset[] = [];
    const warnings: string[] = [];
    let totalImageBytes = 0;
    let imageOrdinal = 0;
    const result = await withTimeout(
      mammoth.convertToHtml(
        { buffer: Buffer.from(input.bytes) },
        {
          styleMap: [
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Subtitle'] => h2:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='标题 1'] => h1:fresh",
            "p[style-name='标题 2'] => h2:fresh",
            "p[style-name='标题 3'] => h3:fresh",
            "p[style-name='标题 4'] => h4:fresh",
          ],
          convertImage: mammoth.images.imgElement(async (image) => {
            imageOrdinal += 1;
            try {
              if (imageOrdinal > MAX_EMBEDDED_IMAGES) {
                warnings.push('Skipped remaining DOCX images: document exceeds 500 images');
                return { src: '' };
              }
              const buffer = await image.readAsBuffer();
              if (buffer.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
                warnings.push(`Skipped DOCX image ${imageOrdinal}: image exceeds 10 MB`);
                return { src: '' };
              }
              if (totalImageBytes + buffer.byteLength > MAX_TOTAL_IMAGE_BYTES) {
                warnings.push(`Skipped DOCX image ${imageOrdinal}: total image data exceeds 50 MB`);
                return { src: '' };
              }

              totalImageBytes += buffer.byteLength;
              const mimeType = image.contentType || 'application/octet-stream';
              const filename = `docx-image-${String(imageOrdinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
              assets.push({
                kind: 'image',
                filename,
                mimeType,
                bytes: new Uint8Array(buffer),
              });
              return { src: assetReference(filename) };
            } catch (error) {
              warnings.push(`Skipped DOCX image ${imageOrdinal}: ${errorMessage(error)}`);
              return { src: '' };
            }
          }),
        },
      ),
      PARSE_TIMEOUT_MS,
      'DOCX parsing timed out after 60 seconds',
    );

    warnings.push(...result.messages.map((message) => message.message));
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    turndown.use(gfm);
    turndown.addRule('word-table', {
      filter: 'table',
      replacement: (_content, node) => {
        const table = node as HTMLTableElement;
        const rows = Array.from(table.rows).map((row) =>
          Array.from(row.cells).map((cell) => cell.textContent?.trim() ?? ''),
        );
        const markdown = toMarkdownTable(rows);
        return markdown ? `\n\n${markdown}\n\n` : '';
      },
    });

    let markdown = cleanMarkdown(turndown.turndown(result.value));
    if (!markdown) throw new Error('Parsed DOCX document is empty');
    const initialStructure = createSectionedMarkdownStructure(markdown, 'docx', warnings);
    const enrichments = await this.enrichImages(initialStructure, assets, warnings, input);
    for (const [original, additions] of enrichments.replacements) {
      markdown = markdown.replace(original, `${original}\n\n${additions.join('\n\n')}`);
    }
    const structure = createSectionedMarkdownStructure(markdown, 'docx', warnings);
    applyEnrichmentSources(structure, enrichments.markers);
    applyAssetAnchors(structure, assets);
    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets,
      warnings,
      stats: { characters: markdown.length },
      structure,
    };
  }

  private async enrichImages(
    structure: StructuredDocument,
    assets: ParsedAsset[],
    warnings: string[],
    input: ParseInput,
  ): Promise<{ replacements: Map<string, string[]>; markers: ImageEnrichment[] }> {
    const replacements = new Map<string, string[]>();
    const markers: ImageEnrichment[] = [];
    if (!this.options.ocrEngine && !this.options.visionEngine) return { replacements, markers };
    const figures = structure.units
      .flatMap((unit) => unit.elements)
      .filter((element) => element.kind === 'figure' && element.assetFilename);
    const assetByFilename = new Map(
      assets.filter((asset) => asset.kind === 'image').map((asset) => [asset.filename, asset]),
    );
    let ocrImages = 0;
    let visionImages = 0;

    for (const figure of figures) {
      const asset = figure.assetFilename ? assetByFilename.get(figure.assetFilename) : undefined;
      if (!asset) continue;
      const dimensions = imageDimensions(asset.bytes, asset.mimeType);
      if (!dimensions) {
        warnings.push(`Skipped DOCX image analysis for ${asset.filename}: dimensions are unknown`);
        continue;
      }
      const pixels = dimensions.width * dimensions.height;
      const additions: string[] = [];
      const nearbyText = nearbyTextForFigure(structure, figure);

      if (
        this.options.ocrEngine &&
        pixels >= this.options.ocrMinPixels &&
        ocrImages < this.options.ocrMaxImages
      ) {
        ocrImages += 1;
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            this.options.ocrEngine.recognize({
              format: 'docx',
              location: figure.location,
              image: asset.bytes,
              width: dimensions.width,
              height: dimensions.height,
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: figure.figureId,
            }),
            this.options.ocrTimeoutMs,
            `DOCX image ${asset.filename} OCR timed out`,
          );
          if (result.text.trim()) {
            const marker = `OCR text: ${cleanMarkdown(result.text)}`;
            additions.push(blockquote(marker));
            markers.push({
              marker,
              source: 'ocr',
              confidence: result.confidence,
              figureId: figure.figureId,
            });
          }
          if (result.confidence < this.options.ocrMinConfidence) {
            warnings.push(
              `DOCX image ${asset.filename} OCR confidence ${result.confidence.toFixed(1)} is below ${this.options.ocrMinConfidence}`,
            );
          }
          await this.observe(
            {
              operation: 'ocr',
              format: 'docx',
              location: figure.location,
              assetId: figure.figureId,
              provider: this.options.ocrProvider,
              status: 'success',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { confidence: result.confidence },
            },
            input,
          );
        } catch (error) {
          warnings.push(`DOCX image ${asset.filename} OCR failed: ${errorMessage(error)}`);
          await this.observe(
            {
              operation: 'ocr',
              format: 'docx',
              location: figure.location,
              assetId: figure.figureId,
              provider: this.options.ocrProvider,
              status: 'failed',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { error: errorMessage(error) },
            },
            input,
          );
        }
      }

      if (
        this.options.visionEngine &&
        pixels >= this.options.visionMinPixels &&
        visionImages < this.options.visionMaxImages
      ) {
        visionImages += 1;
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            this.options.visionEngine.analyze({
              format: 'docx',
              location: figure.location,
              image: asset.bytes,
              mimeType: asset.mimeType,
              width: dimensions.width,
              height: dimensions.height,
              nearbyText,
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: figure.figureId,
            }),
            this.options.visionTimeoutMs,
            `DOCX image ${asset.filename} analysis timed out`,
          );
          if (result.searchable && result.description.trim()) {
            const marker = `Visual analysis: ${result.description.trim()}`;
            additions.push(blockquote(marker));
            markers.push({
              marker,
              source: 'vision',
              confidence: result.confidence,
              kind: 'figure',
              figureId: figure.figureId,
            });
          }
          await this.observe(
            {
              operation: 'vision',
              format: 'docx',
              location: figure.location,
              assetId: figure.figureId,
              provider: this.options.visionProvider,
              model: this.options.visionModel,
              status: 'success',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { kind: result.kind, confidence: result.confidence },
            },
            input,
          );
        } catch (error) {
          warnings.push(`DOCX image ${asset.filename} analysis failed: ${errorMessage(error)}`);
          await this.observe(
            {
              operation: 'vision',
              format: 'docx',
              location: figure.location,
              assetId: figure.figureId,
              provider: this.options.visionProvider,
              model: this.options.visionModel,
              status: 'failed',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { error: errorMessage(error) },
            },
            input,
          );
        }
      }

      if (additions.length > 0) replacements.set(figure.markdown, additions);
    }
    return { replacements, markers };
  }

  private observe(
    metric: Parameters<NonNullable<DocxParserOptions['onProcessingMetric']>>[0],
    input: ParseInput,
  ): Promise<void> {
    return Promise.resolve(
      this.options.onProcessingMetric?.(metric, {
        tenantId: input.tenantId,
        documentVersionId: input.documentVersionId,
      }),
    );
  }
}

function nearbyTextForFigure(
  structure: StructuredDocument,
  figure: StructuredDocumentElement,
): string {
  const unit = structure.units.find((candidate) =>
    candidate.elements.some((element) => element.id === figure.id),
  );
  return (unit?.elements ?? [])
    .filter((element) => element.id !== figure.id && element.searchable)
    .map((element) => element.text)
    .join('\n')
    .slice(0, 2_000);
}

function applyEnrichmentSources(
  structure: StructuredDocument,
  enrichments: ImageEnrichment[],
): void {
  const byMarker = new Map(
    enrichments.map((enrichment) => [normalizeMarker(enrichment.marker), enrichment]),
  );
  for (const element of structure.units.flatMap((unit) => unit.elements)) {
    const enrichment = byMarker.get(normalizeMarker(element.text));
    if (!enrichment) continue;
    element.source = enrichment.source;
    element.confidence = enrichment.confidence;
    element.kind = enrichment.kind ?? element.kind;
    element.figureId = enrichment.figureId ?? element.figureId;
  }
}

function applyAssetAnchors(structure: StructuredDocument, assets: ParsedAsset[]): void {
  const figures = new Map(
    structure.units
      .flatMap((unit) => unit.elements)
      .filter((element) => element.assetFilename)
      .map((element) => [element.assetFilename, element]),
  );
  for (const asset of assets) {
    const figure = figures.get(asset.filename);
    if (!figure || figure.location.type !== 'section') continue;
    asset.anchor = {
      type: 'heading',
      heading: figure.location.heading ?? figure.sectionPath.at(-1),
      sectionPath: [...figure.sectionPath],
    };
  }
}

function normalizeMarker(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function blockquote(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
