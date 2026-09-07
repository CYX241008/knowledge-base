import {
  DOMParser,
  type Document as XmlDocument,
  type Element as XmlElement,
  type Node as XmlNode,
} from '@xmldom/xmldom';
import type JSZip from 'jszip';
import { parseOffice } from 'officeparser';
import { posix } from 'node:path';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult, SourceAnchor } from '../index';
import type {
  BoundingBox,
  DocumentProcessingObserver,
  OcrEngine,
  StructuredDocument,
  StructuredDocumentElement,
  StructuredDocumentTable,
  StructuredDocumentUnit,
  StructuredElementKind,
  StructuredElementSource,
  VisionEngine,
} from '../structured-document';
import { cleanMarkdown, extensionOf, headingAnchors } from './plain-text';
import { loadOfficePackage, readZipBytes, readZipText } from './office-package';
import {
  assetReference,
  extensionForMimeType,
  imageDimensions,
  ParserLimitError,
  sniffImageMimeType,
  toMarkdownTable,
  withTimeout,
} from './parser-utils';
import { createSectionedMarkdownStructure } from './structured-markdown';

const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_PPTX_SLIDES = 500;
const MAX_SLIDE_XML_BYTES = 10 * 1024 * 1024;
const MAX_PPTX_TABLE_CELLS = 250_000;
const MAX_MARKDOWN_CHARACTERS = 5_000_000;
const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 500;
const PARSE_TIMEOUT_MS = 60_000;
const DEFAULT_SLIDE_WIDTH = 12_192_000;
const DEFAULT_SLIDE_HEIGHT = 6_858_000;

export type PptxParserOptions = {
  officeParser?: typeof parseOffice;
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

type ResolvedPptxParserOptions = Required<
  Omit<
    PptxParserOptions,
    'officeParser' | 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'
  >
> &
  Pick<PptxParserOptions, 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'>;

type SlideParagraph = { text: string; list: boolean; level: number };

type SlideImage = {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
};

type SlideItem = {
  id: string;
  kind: StructuredElementKind;
  text: string;
  markdown: string;
  source: StructuredElementSource;
  searchable: boolean;
  sourceOrder: number;
  bbox?: BoundingBox;
  confidence?: number;
  tableId?: string;
  tableRows?: string[][];
  figureId?: string;
  assetFilename?: string;
  image?: SlideImage;
};

type ParsedSlide = {
  slide: number;
  width: number;
  height: number;
  items: SlideItem[];
  imageCount: number;
  ocrImages: number;
  visionImages: number;
};

type PresentationPackage = {
  zip: JSZip;
  slidePaths: string[];
  width: number;
  height: number;
};

type ImageState = {
  count: number;
  totalBytes: number;
  assets: ParsedAsset[];
};

type EnrichmentState = {
  ocrImages: number;
  visionImages: number;
};

export class PptxDocumentParser implements DocumentParser {
  readonly name = 'pptx-ooxml-officeparser';
  readonly version = '3.0.0';

  private readonly options: ResolvedPptxParserOptions;
  private readonly officeParser: typeof parseOffice;

  constructor(options: PptxParserOptions = {}) {
    this.officeParser = options.officeParser ?? parseOffice;
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
    return extension ? extension === 'pptx' : input.mimeType.toLowerCase() === PPTX_MIME_TYPE;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported PPTX format');
    if (input.bytes.byteLength === 0) throw new Error('PPTX file is empty');

    const packageInfo = await loadPresentationPackage(input.bytes);
    try {
      return await this.parsePptxPackage(packageInfo, input);
    } catch (error) {
      if (error instanceof ParserLimitError) throw error;
      return parseWithOfficeParser(
        input.bytes,
        packageInfo.slidePaths.length,
        error,
        this.officeParser,
      );
    }
  }

  private async parsePptxPackage(
    packageInfo: PresentationPackage,
    input: ParseInput,
  ): Promise<ParseResult> {
    const warnings: string[] = [];
    const slides: ParsedSlide[] = [];
    const imageState: ImageState = { count: 0, totalBytes: 0, assets: [] };
    const enrichmentState: EnrichmentState = { ocrImages: 0, visionImages: 0 };
    let tableCells = 0;

    for (const [index, path] of packageInfo.slidePaths.entries()) {
      const slide = await parseSlide(
        packageInfo.zip,
        path,
        index + 1,
        packageInfo.width,
        packageInfo.height,
        imageState,
        warnings,
      );
      tableCells += slide.items.reduce(
        (total, item) =>
          total + (item.tableRows?.reduce((cells, row) => cells + row.length, 0) ?? 0),
        0,
      );
      if (tableCells > MAX_PPTX_TABLE_CELLS) {
        throw new ParserLimitError(`PPTX exceeds the ${MAX_PPTX_TABLE_CELLS}-table-cell limit`);
      }
      await this.enrichSlideImages(slide, input, warnings, enrichmentState);
      slides.push(slide);
    }

    const rendered = renderPresentation(slides, warnings);
    if (!rendered.markdown) throw new Error('Parsed PPTX document is empty');
    if (rendered.markdown.length > MAX_MARKDOWN_CHARACTERS) {
      throw new ParserLimitError(`PPTX Markdown exceeds ${MAX_MARKDOWN_CHARACTERS} characters`);
    }
    return {
      markdown: rendered.markdown,
      anchors: rendered.anchors,
      assets: imageState.assets,
      warnings,
      stats: {
        characters: rendered.markdown.length,
        slides: slides.length,
        tables: rendered.structure.tables.length,
      },
      structure: rendered.structure,
    };
  }

  private async enrichSlideImages(
    slide: ParsedSlide,
    input: ParseInput,
    warnings: string[],
    state: EnrichmentState,
  ): Promise<void> {
    const imageItems = slide.items.filter((item) => item.image);
    for (const item of imageItems) {
      const image = item.image;
      if (!image) continue;
      const pixels = image.width * image.height;
      const additions: SlideItem[] = [];

      if (
        this.options.ocrEngine &&
        pixels >= this.options.ocrMinPixels &&
        state.ocrImages < this.options.ocrMaxImages
      ) {
        state.ocrImages += 1;
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            this.options.ocrEngine.recognize({
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              image: image.bytes,
              width: image.width,
              height: image.height,
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: item.figureId,
            }),
            this.options.ocrTimeoutMs,
            `PPTX slide ${slide.slide} image ${image.filename} OCR timed out`,
          );
          const blocks = result.blocks.length
            ? result.blocks
            : result.text.trim()
              ? [{ text: result.text, confidence: result.confidence }]
              : [];
          additions.push(
            ...blocks
              .filter((block) => block.text.trim())
              .map((block, index): SlideItem => ({
                id: `${item.id}-ocr-${index + 1}`,
                kind: 'paragraph',
                text: cleanMarkdown(block.text),
                markdown: blockquote(`OCR text: ${cleanMarkdown(block.text)}`),
                source: 'ocr',
                searchable: true,
                sourceOrder: item.sourceOrder + (index + 1) / 100,
                bbox: mapImageBox(block.bbox, item.bbox),
                confidence: block.confidence,
                figureId: item.figureId,
                assetFilename: item.assetFilename,
              })),
          );
          slide.ocrImages += 1;
          if (result.confidence < this.options.ocrMinConfidence) {
            warnings.push(
              `PPTX slide ${slide.slide} image ${image.filename} OCR confidence ${result.confidence.toFixed(1)} is below ${this.options.ocrMinConfidence}`,
            );
          }
          await this.observe(
            {
              operation: 'ocr',
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              assetId: item.figureId,
              provider: this.options.ocrProvider,
              status: 'success',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { confidence: result.confidence },
            },
            input,
          );
        } catch (error) {
          warnings.push(
            `PPTX slide ${slide.slide} image ${image.filename} OCR failed: ${errorMessage(error)}`,
          );
          await this.observe(
            {
              operation: 'ocr',
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              assetId: item.figureId,
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
        state.visionImages < this.options.visionMaxImages
      ) {
        state.visionImages += 1;
        const startedAt = Date.now();
        try {
          const result = await withTimeout(
            this.options.visionEngine.analyze({
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              image: image.bytes,
              mimeType: image.mimeType,
              width: image.width,
              height: image.height,
              nearbyText: slide.items
                .filter((candidate) => candidate.searchable && candidate.kind !== 'figure')
                .map((candidate) => candidate.text)
                .join('\n')
                .slice(0, 2_000),
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: item.figureId,
            }),
            this.options.visionTimeoutMs,
            `PPTX slide ${slide.slide} image ${image.filename} analysis timed out`,
          );
          slide.visionImages += 1;
          additions.push({
            id: `${item.id}-vision`,
            kind: result.kind === 'table' ? 'table' : 'figure',
            text: result.description.trim(),
            markdown: blockquote(`Visual analysis: ${result.description.trim()}`),
            source: 'vision',
            searchable: result.searchable && Boolean(result.description.trim()),
            sourceOrder: item.sourceOrder + 0.9,
            bbox: item.bbox,
            confidence: result.confidence,
            figureId: item.figureId,
            assetFilename: item.assetFilename,
          });
          await this.observe(
            {
              operation: 'vision',
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              assetId: item.figureId,
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
          warnings.push(
            `PPTX slide ${slide.slide} image ${image.filename} analysis failed: ${errorMessage(error)}`,
          );
          await this.observe(
            {
              operation: 'vision',
              format: 'pptx',
              location: { type: 'slide', slide: slide.slide },
              assetId: item.figureId,
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
      slide.items.push(...additions);
    }
  }

  private observe(
    metric: Parameters<NonNullable<PptxParserOptions['onProcessingMetric']>>[0],
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

async function loadPresentationPackage(bytes: Uint8Array): Promise<PresentationPackage> {
  const zip = await loadOfficePackage(bytes, 'PPTX');
  const presentation = zip.file('ppt/presentation.xml');
  const presentationDocument = presentation
    ? parseXml(await readZipText(presentation, 'PPTX', MAX_SLIDE_XML_BYTES), 'PPTX presentation')
    : undefined;
  const slidePaths = await orderedSlidePaths(zip, presentationDocument);
  if (slidePaths.length === 0) throw new Error('PPTX package contains no slides');
  if (slidePaths.length > MAX_PPTX_SLIDES) {
    throw new ParserLimitError(`PPTX exceeds the ${MAX_PPTX_SLIDES}-slide limit`);
  }
  const slideSize = presentationDocument
    ? firstDescendant(presentationDocument, 'sldSz')
    : undefined;
  return {
    zip,
    slidePaths,
    width: positiveNumber(slideSize?.getAttribute('cx')) ?? DEFAULT_SLIDE_WIDTH,
    height: positiveNumber(slideSize?.getAttribute('cy')) ?? DEFAULT_SLIDE_HEIGHT,
  };
}

async function parseSlide(
  zip: JSZip,
  path: string,
  slideNumber: number,
  slideWidth: number,
  slideHeight: number,
  imageState: ImageState,
  warnings: string[],
): Promise<ParsedSlide> {
  const file = zip.file(path);
  if (!file) throw new Error(`PPTX slide entry is missing: ${path}`);
  const xml = await readZipText(file, 'PPTX', MAX_SLIDE_XML_BYTES);
  const document = parseXml(xml, `PPTX slide ${slideNumber}`);
  const relationships = await slideRelationships(zip, path);
  const tree = firstDescendant(document, 'spTree');
  if (!tree) throw new Error(`PPTX slide ${slideNumber} contains no shape tree`);

  const items: SlideItem[] = [];
  let tableOrdinal = 0;
  let imageOrdinal = 0;
  for (const [sourceOrder, element] of childElements(tree).entries()) {
    switch (element.localName) {
      case 'sp': {
        if (isAuxiliaryShape(element)) break;
        const paragraphs = extractParagraphs(element);
        if (paragraphs.length === 0) break;
        const title = isTitleShape(element);
        const text = paragraphs
          .map((paragraph) => paragraph.text)
          .join(title ? ' ' : '\n')
          .trim();
        if (!text) break;
        items.push({
          id: `s${slideNumber}-e${sourceOrder + 1}`,
          kind: title
            ? 'heading'
            : paragraphs.every((paragraph) => paragraph.list)
              ? 'list'
              : 'paragraph',
          text,
          markdown: title
            ? `### ${text}`
            : paragraphs
                .map((paragraph) =>
                  paragraph.list
                    ? `${'  '.repeat(paragraph.level)}- ${paragraph.text}`
                    : paragraph.text,
                )
                .join('\n'),
          source: 'native',
          searchable: true,
          sourceOrder,
          bbox: elementBox(element, slideWidth, slideHeight),
        });
        break;
      }
      case 'graphicFrame': {
        const rows = extractTable(element);
        if (rows.length === 0) break;
        tableOrdinal += 1;
        const tableId = `s${slideNumber}-t${tableOrdinal}`;
        const markdown = toMarkdownTable(rows);
        items.push({
          id: tableId,
          kind: 'table',
          text: rows.map((row) => row.join(' | ')).join('\n'),
          markdown: `### Table ${tableOrdinal}\n\n${markdown}`,
          source: 'native',
          searchable: true,
          sourceOrder,
          bbox: elementBox(element, slideWidth, slideHeight),
          tableId,
          tableRows: rows,
        });
        break;
      }
      case 'pic': {
        imageOrdinal += 1;
        const picture = await extractPicture(
          zip,
          path,
          element,
          relationships,
          slideNumber,
          imageOrdinal,
          slideWidth,
          slideHeight,
          imageState,
          warnings,
        );
        if (picture) items.push({ ...picture, sourceOrder });
        break;
      }
    }
  }

  return {
    slide: slideNumber,
    width: slideWidth,
    height: slideHeight,
    items,
    imageCount: items.filter((item) => item.image).length,
    ocrImages: 0,
    visionImages: 0,
  };
}

async function extractPicture(
  zip: JSZip,
  slidePath: string,
  picture: XmlElement,
  relationships: Map<string, string>,
  slideNumber: number,
  ordinal: number,
  slideWidth: number,
  slideHeight: number,
  state: ImageState,
  warnings: string[],
): Promise<SlideItem | undefined> {
  const blip = firstDescendant(picture, 'blip');
  const relationshipId = blip ? relationshipAttribute(blip, 'embed') : undefined;
  const target = relationshipId ? relationships.get(relationshipId) : undefined;
  if (!target) {
    warnings.push(`Skipped PPTX slide ${slideNumber} image ${ordinal}: relationship is missing`);
    return undefined;
  }
  const imagePath = resolveRelationshipTarget(slidePath, target);
  const file = zip.file(imagePath);
  if (!file) {
    warnings.push(`Skipped PPTX slide ${slideNumber} image ${ordinal}: ${imagePath} is missing`);
    return undefined;
  }
  if (state.count >= MAX_EMBEDDED_IMAGES) {
    warnings.push('Skipped remaining PPTX images: document exceeds 500 images');
    return undefined;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readZipBytes(file, 'PPTX', MAX_EMBEDDED_IMAGE_BYTES);
  } catch (error) {
    warnings.push(`Skipped PPTX slide ${slideNumber} image ${ordinal}: ${errorMessage(error)}`);
    return undefined;
  }
  if (state.totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
    warnings.push('Skipped remaining PPTX images: total image data exceeds 50 MB');
    return undefined;
  }
  state.count += 1;
  state.totalBytes += bytes.byteLength;
  const mimeType = sniffImageMimeType(bytes, mimeTypeForPath(imagePath));
  const filename = `pptx-image-s${slideNumber}-${String(ordinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
  const dimensions = imageDimensions(bytes, mimeType);
  const image: SlideImage = {
    id: `s${slideNumber}-f${ordinal}`,
    filename,
    mimeType,
    bytes,
    width: dimensions?.width ?? 0,
    height: dimensions?.height ?? 0,
  };
  state.assets.push({
    kind: 'image',
    filename,
    mimeType,
    bytes,
    anchor: { type: 'slide', slide: slideNumber },
  });
  const properties = firstDescendant(picture, 'cNvPr');
  const text =
    properties?.getAttribute('descr')?.trim() ||
    properties?.getAttribute('title')?.trim() ||
    properties?.getAttribute('name')?.trim() ||
    `PPTX slide ${slideNumber} image ${ordinal}`;
  return {
    id: image.id,
    kind: 'figure',
    text,
    markdown: `![${escapeImageAlt(text)}](${assetReference(filename)})`,
    source: 'derived',
    searchable: false,
    sourceOrder: ordinal,
    bbox: elementBox(picture, slideWidth, slideHeight),
    figureId: image.id,
    assetFilename: filename,
    image,
  };
}

function renderPresentation(
  slides: ParsedSlide[],
  warnings: string[],
): { markdown: string; anchors: SourceAnchor[]; structure: StructuredDocument } {
  let markdown = '';
  const anchors: SourceAnchor[] = [];
  const units: StructuredDocumentUnit[] = [];
  const tables: StructuredDocumentTable[] = [];
  for (const slide of slides) {
    if (markdown) markdown += '\n\n';
    const slideStart = markdown.length;
    markdown += `## Slide ${slide.slide}`;
    const elements: StructuredDocumentElement[] = [];
    let sectionPath: string[] = [];
    const orderedItems = [...slide.items].sort(compareSlideItems);
    for (const item of orderedItems) {
      if (!item.markdown.trim()) continue;
      if (item.kind === 'heading') sectionPath = [item.text.trim()];
      markdown += '\n\n';
      const offsetStart = markdown.length;
      markdown += item.markdown.trim();
      const offsetEnd = markdown.length;
      const element: StructuredDocumentElement = {
        id: item.id,
        kind: item.kind,
        location: { type: 'slide', slide: slide.slide },
        order: elements.length + 1,
        text: item.text.trim(),
        markdown: item.markdown.trim(),
        offsetStart,
        offsetEnd,
        searchable: item.searchable,
        source: item.source,
        sectionPath: [...sectionPath],
        bbox: item.bbox,
        confidence: item.confidence,
        tableId: item.tableId,
        figureId: item.figureId,
        assetFilename: item.assetFilename,
      };
      elements.push(element);
      anchors.push({
        type: 'slide',
        slide: slide.slide,
        heading: sectionPath.at(-1),
        offsetStart,
        offsetEnd,
        elementId: element.id,
        elementIds: [element.id],
        elementType: element.kind,
        sectionPath: element.sectionPath,
        tableId: element.tableId,
        figureId: element.figureId,
        boundingBoxes: element.bbox ? [element.bbox] : undefined,
        confidence: element.confidence,
      });
      if (item.tableId && item.tableRows) {
        tables.push({
          id: item.tableId,
          location: { type: 'slide', slide: slide.slide },
          rows: item.tableRows,
          markdown: toMarkdownTable(item.tableRows),
        });
      }
    }
    anchors.push({
      type: 'slide',
      slide: slide.slide,
      offsetStart: slideStart,
      offsetEnd: markdown.length,
    });
    units.push({
      id: `slide-${slide.slide}`,
      location: { type: 'slide', slide: slide.slide },
      width: slide.width,
      height: slide.height,
      imageCount: slide.imageCount,
      ocrApplied: slide.ocrImages > 0,
      visionAnalyzedImages: slide.visionImages,
      elements,
    });
  }
  const imageCount = slides.reduce((sum, slide) => sum + slide.imageCount, 0);
  const ocrImages = slides.reduce((sum, slide) => sum + slide.ocrImages, 0);
  const visionImages = slides.reduce((sum, slide) => sum + slide.visionImages, 0);
  const reasons = warnings.filter((warning) => /failed|missing|unknown|below/iu.test(warning));
  const score = Math.max(0, 100 - Math.min(50, reasons.length * 10));
  return {
    markdown: cleanMarkdown(markdown),
    anchors,
    structure: {
      version: 2,
      format: 'pptx',
      units,
      tables,
      quality: {
        status: reasons.length > 0 ? 'review' : 'pass',
        score,
        reasons,
        metrics: {
          slides: slides.length,
          images: imageCount,
          ocrImages,
          visionImages,
          tables: tables.length,
        },
      },
    },
  };
}

async function parseWithOfficeParser(
  bytes: Uint8Array,
  slideCount: number,
  primaryError: unknown,
  officeParser: typeof parseOffice,
): Promise<ParseResult> {
  try {
    const ast = await withTimeout(
      officeParser(bytes, {
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
    const warnings = [
      `OOXML parsing failed; used officeparser fallback: ${errorMessage(primaryError)}`,
    ];
    return {
      markdown,
      anchors: headingAnchors(markdown),
      assets: [],
      warnings,
      stats: { characters: markdown.length, slides: slideCount },
      structure: createSectionedMarkdownStructure(markdown, 'pptx', warnings),
    };
  } catch (fallbackError) {
    if (fallbackError instanceof ParserLimitError) throw fallbackError;
    throw new Error(
      `PPTX parsing failed (OOXML: ${errorMessage(primaryError)}; officeparser: ${errorMessage(fallbackError)})`,
    );
  }
}

async function orderedSlidePaths(zip: JSZip, presentation?: XmlDocument): Promise<string[]> {
  const relationships = zip.file('ppt/_rels/presentation.xml.rels');
  if (presentation && relationships) {
    const relationshipsXml = await readZipText(relationships, 'PPTX', MAX_SLIDE_XML_BYTES);
    const targets = relationshipTargets(parseXml(relationshipsXml, 'PPTX relationships'), 'slide');
    const ordered = elementsByLocalName(presentation, 'sldId')
      .map((element) => targets.get(relationshipAttribute(element, 'id') ?? ''))
      .map((target) =>
        target ? resolveRelationshipTarget('ppt/presentation.xml', target) : undefined,
      )
      .filter((path): path is string => Boolean(path && zip.file(path)));
    if (ordered.length > 0) return ordered;
  }
  return Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((left, right) => slideNumber(left) - slideNumber(right));
}

async function slideRelationships(zip: JSZip, slidePath: string): Promise<Map<string, string>> {
  const relationshipPath = posix.join(
    posix.dirname(slidePath),
    '_rels',
    `${posix.basename(slidePath)}.rels`,
  );
  const file = zip.file(relationshipPath);
  if (!file) return new Map();
  const xml = await readZipText(file, 'PPTX', MAX_SLIDE_XML_BYTES);
  return relationshipTargets(parseXml(xml, `PPTX relationships for ${slidePath}`), 'image');
}

function relationshipTargets(document: XmlDocument, relationshipKind: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const relationship of elementsByLocalName(document, 'Relationship')) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    const type = relationship.getAttribute('Type');
    if (id && target && type?.endsWith(`/${relationshipKind}`)) targets.set(id, target);
  }
  return targets;
}

function extractParagraphs(element: XmlElement): SlideParagraph[] {
  return elementsByLocalName(element, 'p').flatMap((paragraph) => {
    const text = drawingText(paragraph).trim();
    if (!text) return [];
    const properties = firstDirectChild(paragraph, 'pPr');
    const level = Math.max(0, Number(properties?.getAttribute('lvl') ?? 0));
    return [
      {
        text,
        list: Boolean(
          firstDescendant(paragraph, 'buChar') ?? firstDescendant(paragraph, 'buAutoNum'),
        ),
        level: Number.isFinite(level) ? level : 0,
      },
    ];
  });
}

function extractTable(element: XmlElement): string[][] {
  const table = firstDescendant(element, 'tbl');
  if (!table) return [];
  return directChildren(table, 'tr')
    .map((row) =>
      directChildren(row, 'tc').map((cell) => {
        const properties = firstDirectChild(cell, 'tcPr');
        if (
          properties?.getAttribute('hMerge') === '1' ||
          properties?.getAttribute('vMerge') === '1'
        ) {
          return '';
        }
        return extractParagraphs(cell)
          .map((paragraph) => paragraph.text)
          .join(' ')
          .trim();
      }),
    )
    .filter((row) => row.length > 0);
}

function isTitleShape(shape: XmlElement): boolean {
  const placeholderType = firstDescendant(shape, 'ph')?.getAttribute('type');
  if (/^(?:ctrTitle|title)$/i.test(placeholderType ?? '')) return true;
  const name = firstDescendant(shape, 'cNvPr')?.getAttribute('name') ?? '';
  if (/(?:subtitle|eyebrow|footer|slide[\s_-]*number)/i.test(name)) return false;
  return /(?:^|[\s_-])(?:title|titel|titre|标题)(?:$|[\s_-])/i.test(name);
}

function isAuxiliaryShape(shape: XmlElement): boolean {
  const placeholderType = firstDescendant(shape, 'ph')?.getAttribute('type');
  if (/^(?:dt|ftr|sldNum)$/i.test(placeholderType ?? '')) return true;
  const name = firstDescendant(shape, 'cNvPr')?.getAttribute('name') ?? '';
  return /(?:^|[\s_-])(?:footer|slide[\s_-]*number)(?:$|[\s_-])/i.test(name);
}

function drawingText(element: XmlElement): string {
  let text = '';
  const visit = (node: XmlNode) => {
    if (node.nodeType !== 1) return;
    const current = node as XmlElement;
    if (current.localName === 't') {
      text += current.textContent ?? '';
      return;
    }
    if (current.localName === 'br') {
      text += '\n';
      return;
    }
    for (const child of childElements(current)) visit(child);
  };
  visit(element);
  return text;
}

function elementBox(
  element: XmlElement,
  slideWidth: number,
  slideHeight: number,
): BoundingBox | undefined {
  const transform = firstDescendant(element, 'xfrm');
  const offset = transform ? firstDescendant(transform, 'off') : undefined;
  const extent = transform ? firstDescendant(transform, 'ext') : undefined;
  const x = positiveNumber(offset?.getAttribute('x'), true);
  const y = positiveNumber(offset?.getAttribute('y'), true);
  const width = positiveNumber(extent?.getAttribute('cx'));
  const height = positiveNumber(extent?.getAttribute('cy'));
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return {
    x: clamp(x / Math.max(1, slideWidth)),
    y: clamp(y / Math.max(1, slideHeight)),
    width: clamp(width / Math.max(1, slideWidth)),
    height: clamp(height / Math.max(1, slideHeight)),
  };
}

function compareSlideItems(left: SlideItem, right: SlideItem): number {
  if (left.bbox && right.bbox) {
    const vertical = left.bbox.y - right.bbox.y;
    if (Math.abs(vertical) > 0.01) return vertical;
    const horizontal = left.bbox.x - right.bbox.x;
    if (Math.abs(horizontal) > 0.01) return horizontal;
  } else if (left.bbox) {
    return -1;
  } else if (right.bbox) {
    return 1;
  }
  return left.sourceOrder - right.sourceOrder;
}

function mapImageBox(
  inner: BoundingBox | undefined,
  outer: BoundingBox | undefined,
): BoundingBox | undefined {
  if (!inner) return outer;
  if (!outer) return inner;
  return {
    x: clamp(outer.x + inner.x * outer.width),
    y: clamp(outer.y + inner.y * outer.height),
    width: clamp(inner.width * outer.width),
    height: clamp(inner.height * outer.height),
  };
}

function parseXml(xml: string, label: string): XmlDocument {
  return new DOMParser({
    onError(level, message) {
      if (level !== 'warning') throw new Error(`${label} XML is invalid: ${message}`);
    },
  }).parseFromString(xml, 'application/xml');
}

function elementsByLocalName(parent: XmlDocument | XmlElement, localName: string): XmlElement[] {
  return Array.from(parent.getElementsByTagName('*')).filter(
    (element) => element.localName === localName,
  );
}

function firstDescendant(
  parent: XmlDocument | XmlElement,
  localName: string,
): XmlElement | undefined {
  return elementsByLocalName(parent, localName)[0];
}

function childElements(parent: XmlElement): XmlElement[] {
  return Array.from(parent.childNodes).filter((node): node is XmlElement => node.nodeType === 1);
}

function directChildren(parent: XmlElement, localName: string): XmlElement[] {
  return childElements(parent).filter((element) => element.localName === localName);
}

function firstDirectChild(parent: XmlElement, localName: string): XmlElement | undefined {
  return directChildren(parent, localName)[0];
}

function relationshipAttribute(element: XmlElement, localName: string): string | undefined {
  return Array.from(element.attributes).find(
    (attribute) => attribute.localName === localName && attribute.name.includes(':'),
  )?.value;
}

function resolveRelationshipTarget(sourcePath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return posix.normalize(posix.join(posix.dirname(sourcePath), target));
}

function mimeTypeForPath(path: string): string {
  const extension = extensionOf(path);
  const mimeTypes: Record<string, string> = {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return mimeTypes[extension] ?? 'application/octet-stream';
}

function escapeImageAlt(value: string): string {
  return value.replace(/[[\]]/gu, '').replace(/\s+/gu, ' ').trim();
}

function positiveNumber(value: string | null | undefined, allowZero = false): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0) ? number : undefined;
}

function blockquote(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/i)?.[1] ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
