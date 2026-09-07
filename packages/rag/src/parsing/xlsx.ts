import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from '@xmldom/xmldom';
import ExcelJS from 'exceljs';
import type JSZip from 'jszip';
import { parseOffice } from 'officeparser';
import { posix } from 'node:path';
import type { DocumentParser, ParsedAsset, ParseInput, ParseResult, SourceAnchor } from '../index';
import type {
  DocumentProcessingObserver,
  OcrEngine,
  StructuredDocument,
  VisionEngine,
} from '../structured-document';
import { cleanMarkdown, extensionOf } from './plain-text';
import { loadOfficePackage, readZipText } from './office-package';
import {
  assetReference,
  extensionForMimeType,
  imageDimensions,
  ParserLimitError,
  sniffImageMimeType,
  toMarkdownTable,
  withTimeout,
} from './parser-utils';
import {
  createFixedUnitMarkdownStructure,
  createSectionedMarkdownStructure,
  type StructuredMarkdownSection,
} from './structured-markdown';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_XLSX_SHEETS = 100;
const MAX_XLSX_ROWS_PER_SHEET = 50_000;
const MAX_XLSX_COLUMNS = 256;
const MAX_XLSX_CELLS = 500_000;
const MAX_WORKSHEET_XML_BYTES = 25 * 1024 * 1024;
const MAX_MARKDOWN_CHARACTERS = 5_000_000;
const PARSE_TIMEOUT_MS = 60_000;
const MAX_FORMULA_WARNINGS = 100;
const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_EMBEDDED_IMAGES = 500;

type WorksheetSection = {
  id: string;
  markdown: string;
  sheet: string;
  rowStart?: number;
  rowEnd?: number;
  range?: string;
};

type SheetCell = { row: number; column: number; value: string };

type DataRegion = {
  id: string;
  name?: string;
  sheet: string;
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
  range: string;
  rows: string[][];
};

type ImageEnrichment = {
  marker: string;
  source: 'ocr' | 'vision' | 'derived';
  confidence?: number;
  kind?: 'figure';
  figureId?: string;
};

type ChartExtraction = {
  sections: WorksheetSection[];
  enrichments: ImageEnrichment[];
};

export type XlsxParserOptions = {
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

export class XlsxDocumentParser implements DocumentParser {
  readonly name = 'exceljs-officeparser';
  readonly version = '3.0.0';

  private readonly options: Required<
    Omit<
      XlsxParserOptions,
      'officeParser' | 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'
    >
  > &
    Pick<XlsxParserOptions, 'ocrEngine' | 'visionEngine' | 'visionModel' | 'onProcessingMetric'>;
  private readonly officeParser: typeof parseOffice;

  constructor(options: XlsxParserOptions = {}) {
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
    return extension ? extension === 'xlsx' : input.mimeType.toLowerCase() === XLSX_MIME_TYPE;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported XLSX format');
    if (input.bytes.byteLength === 0) throw new Error('XLSX file is empty');

    const normalizedBytes = await preflightAndNormalizeXlsx(input.bytes);
    try {
      return await this.parseWithExcelJs(normalizedBytes, input);
    } catch (error) {
      if (error instanceof ParserLimitError) throw error;
      return this.parseWithOfficeParser(normalizedBytes, error);
    }
  }

  private async parseWithExcelJs(bytes: Uint8Array, input: ParseInput): Promise<ParseResult> {
    const zip = await loadOfficePackage(bytes, 'XLSX');
    const worksheetPathByName = await worksheetPaths(zip);
    const chartsBySheet = new Map<string, ChartExtraction>();
    for (const [sheet, path] of worksheetPathByName) {
      chartsBySheet.set(
        sheet,
        await extractWorksheetCharts(zip, path, sheet, chartsBySheet.size + 1),
      );
    }
    const excelBytes = await removeChartAnchors(zip);
    const workbook = new ExcelJS.Workbook();
    await withTimeout(
      workbook.xlsx.load(Buffer.from(excelBytes) as unknown as ExcelJS.Buffer),
      PARSE_TIMEOUT_MS,
      'XLSX parsing timed out after 60 seconds',
    );
    if (workbook.worksheets.length > MAX_XLSX_SHEETS) {
      throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_SHEETS}-sheet limit`);
    }

    const warnings: string[] = [];
    const sections: WorksheetSection[] = [];
    const assets: ParsedAsset[] = [];
    const enrichments: ImageEnrichment[] = [];
    let totalCells = 0;
    let regionCount = 0;
    let chartCount = 0;
    let imageCount = 0;
    let totalImageBytes = 0;
    let ocrImages = 0;
    let visionImages = 0;
    for (const [sheetIndex, sheet] of workbook.worksheets.entries()) {
      if (sheet.rowCount > MAX_XLSX_ROWS_PER_SHEET) {
        throw new ParserLimitError(
          `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_ROWS_PER_SHEET}-row limit`,
        );
      }
      if (sheet.columnCount > MAX_XLSX_COLUMNS) {
        throw new ParserLimitError(
          `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_COLUMNS}-column limit`,
        );
      }

      const cells = collectSheetCells(sheet, warnings);
      totalCells += cells.length;
      if (totalCells > MAX_XLSX_CELLS) {
        throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_CELLS}-cell limit`);
      }
      const regions = worksheetRegions(sheet, cells);
      for (const [regionIndex, region] of regions.entries()) {
        regionCount += 1;
        sections.push(regionSection(region, sheetIndex + 1, regionIndex + 1));
      }

      const charts = chartsBySheet.get(sheet.name) ?? { sections: [], enrichments: [] };
      chartCount += charts.sections.length;
      sections.push(...charts.sections);
      enrichments.push(...charts.enrichments);

      const extractedImages = await this.extractWorksheetImages(
        workbook,
        sheet,
        sheetIndex + 1,
        input,
        warnings,
        imageCount,
        totalImageBytes,
      );
      imageCount += extractedImages.assets.length;
      totalImageBytes += extractedImages.assets.reduce(
        (sum, asset) => sum + asset.bytes.byteLength,
        0,
      );
      ocrImages += extractedImages.ocrImages;
      visionImages += extractedImages.visionImages;
      assets.push(...extractedImages.assets);
      sections.push(...extractedImages.sections);
      enrichments.push(...extractedImages.enrichments);

      if (
        regions.length === 0 &&
        charts.sections.length === 0 &&
        extractedImages.sections.length === 0
      ) {
        sections.push({
          id: `sheet-${sheetIndex + 1}`,
          markdown: `## Sheet: ${sheet.name}`,
          sheet: sheet.name,
        });
      }
    }

    const { markdown, anchors, structuredSections } = joinSections(sections);
    if (!markdown) throw new Error('Parsed XLSX document is empty');
    assertMarkdownLimit(markdown, 'XLSX');
    const structure = createFixedUnitMarkdownStructure('xlsx', structuredSections, warnings);
    applyEnrichmentSources(structure, enrichments);
    structure.quality.metrics.regions = regionCount;
    structure.quality.metrics.charts = chartCount;
    structure.quality.metrics.images = imageCount;
    structure.quality.metrics.ocrImages = ocrImages;
    structure.quality.metrics.visionImages = visionImages;
    return {
      markdown,
      anchors,
      assets,
      warnings,
      stats: {
        characters: markdown.length,
        sheets: workbook.worksheets.length,
        tables: structure.tables.length,
      },
      structure,
    };
  }

  private async extractWorksheetImages(
    workbook: ExcelJS.Workbook,
    sheet: ExcelJS.Worksheet,
    sheetIndex: number,
    input: ParseInput,
    warnings: string[],
    existingImageCount: number,
    existingImageBytes: number,
  ): Promise<{
    assets: ParsedAsset[];
    sections: WorksheetSection[];
    enrichments: ImageEnrichment[];
    ocrImages: number;
    visionImages: number;
  }> {
    const assets: ParsedAsset[] = [];
    const sections: WorksheetSection[] = [];
    const enrichments: ImageEnrichment[] = [];
    let totalBytes = existingImageBytes;
    let ocrImages = 0;
    let visionImages = 0;
    const nearbyText = worksheetNearbyText(sheet);

    for (const [index, reference] of sheet.getImages().entries()) {
      const ordinal = index + 1;
      if (existingImageCount + assets.length >= MAX_EMBEDDED_IMAGES) {
        warnings.push('Skipped remaining XLSX images: document exceeds 500 images');
        break;
      }
      const source = workbook.getImage(Number(reference.imageId));
      const bytes = workbookImageBytes(source);
      if (!bytes?.byteLength) {
        warnings.push(`Skipped XLSX image ${sheet.name}#${ordinal}: image data is unavailable`);
        continue;
      }
      if (bytes.byteLength > MAX_EMBEDDED_IMAGE_BYTES) {
        warnings.push(`Skipped XLSX image ${sheet.name}#${ordinal}: image exceeds 10 MB`);
        continue;
      }
      if (totalBytes + bytes.byteLength > MAX_TOTAL_IMAGE_BYTES) {
        warnings.push('Skipped remaining XLSX images: total image data exceeds 50 MB');
        break;
      }
      totalBytes += bytes.byteLength;
      const mimeType = sniffImageMimeType(
        bytes,
        source?.extension ? mimeTypeForExtension(source.extension) : 'image/png',
      );
      const dimensions = imageDimensions(bytes, mimeType);
      const range = imageCellRange(reference.range);
      const location = {
        type: 'sheet' as const,
        sheet: sheet.name,
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        range: range.range,
      };
      const filename = `xlsx-image-s${sheetIndex}-${String(ordinal).padStart(3, '0')}.${extensionForMimeType(mimeType)}`;
      const sectionId = `sheet-${sheetIndex}-image-${ordinal}`;
      const figureId = `${sectionId}-f1`;
      const additions: string[] = [];

      if (
        this.options.ocrEngine &&
        dimensions &&
        dimensions.width * dimensions.height >= this.options.ocrMinPixels &&
        ocrImages < this.options.ocrMaxImages
      ) {
        const startedAt = Date.now();
        ocrImages += 1;
        try {
          const result = await withTimeout(
            this.options.ocrEngine.recognize({
              format: 'xlsx',
              location,
              image: bytes,
              width: dimensions.width,
              height: dimensions.height,
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: figureId,
            }),
            this.options.ocrTimeoutMs,
            `XLSX image ${sheet.name}#${ordinal} OCR timed out`,
          );
          if (result.text.trim()) {
            const marker = `OCR text: ${cleanMarkdown(result.text)}`;
            additions.push(blockquote(marker));
            enrichments.push({
              marker,
              source: 'ocr',
              confidence: result.confidence,
              figureId,
            });
          }
          if (result.confidence < this.options.ocrMinConfidence) {
            warnings.push(
              `XLSX image ${sheet.name}#${ordinal} OCR confidence ${result.confidence.toFixed(1)} is below ${this.options.ocrMinConfidence}`,
            );
          }
          await this.observe(
            {
              operation: 'ocr',
              format: 'xlsx',
              location,
              assetId: figureId,
              provider: this.options.ocrProvider,
              status: 'success',
              durationMs: Date.now() - startedAt,
              cacheHit: false,
              metadata: { confidence: result.confidence },
            },
            input,
          );
        } catch (error) {
          warnings.push(`XLSX image ${sheet.name}#${ordinal} OCR failed: ${errorMessage(error)}`);
          await this.observe(
            {
              operation: 'ocr',
              format: 'xlsx',
              location,
              assetId: figureId,
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
        dimensions &&
        dimensions.width * dimensions.height >= this.options.visionMinPixels &&
        visionImages < this.options.visionMaxImages
      ) {
        const startedAt = Date.now();
        visionImages += 1;
        try {
          const result = await withTimeout(
            this.options.visionEngine.analyze({
              format: 'xlsx',
              location,
              image: bytes,
              mimeType,
              width: dimensions.width,
              height: dimensions.height,
              nearbyText,
              tenantId: input.tenantId,
              runId: input.documentVersionId,
              assetId: figureId,
            }),
            this.options.visionTimeoutMs,
            `XLSX image ${sheet.name}#${ordinal} analysis timed out`,
          );
          if (result.searchable && result.description.trim()) {
            const marker = `Visual analysis: ${result.description.trim()}`;
            additions.push(blockquote(marker));
            enrichments.push({
              marker,
              source: 'vision',
              confidence: result.confidence,
              figureId,
            });
          }
          await this.observe(
            {
              operation: 'vision',
              format: 'xlsx',
              location,
              assetId: figureId,
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
            `XLSX image ${sheet.name}#${ordinal} analysis failed: ${errorMessage(error)}`,
          );
          await this.observe(
            {
              operation: 'vision',
              format: 'xlsx',
              location,
              assetId: figureId,
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

      assets.push({
        kind: 'image',
        filename,
        mimeType,
        bytes,
        anchor: {
          type: 'sheet',
          sheet: sheet.name,
          rowStart: range.rowStart,
          rowEnd: range.rowEnd,
          range: range.range,
        },
      });
      sections.push({
        id: sectionId,
        sheet: sheet.name,
        rowStart: range.rowStart,
        rowEnd: range.rowEnd,
        range: range.range,
        markdown: cleanMarkdown(
          [
            `## Sheet: ${sheet.name}`,
            `### Image ${ordinal} (${range.range})`,
            `![Worksheet image ${ordinal}](${assetReference(filename)})`,
            ...additions,
          ].join('\n\n'),
        ),
      });
    }
    return { assets, sections, enrichments, ocrImages, visionImages };
  }

  private observe(
    metric: Parameters<NonNullable<XlsxParserOptions['onProcessingMetric']>>[0],
    input: ParseInput,
  ): Promise<void> {
    return Promise.resolve(
      this.options.onProcessingMetric?.(metric, {
        tenantId: input.tenantId,
        documentVersionId: input.documentVersionId,
      }),
    );
  }

  private async parseWithOfficeParser(
    bytes: Uint8Array,
    primaryError: unknown,
  ): Promise<ParseResult> {
    try {
      const ast = await withTimeout(
        this.officeParser(bytes, { fileType: 'xlsx', extractAttachments: false }),
        PARSE_TIMEOUT_MS,
        'XLSX fallback parsing timed out after 60 seconds',
      );
      const converted = await withTimeout(
        ast.to('md'),
        PARSE_TIMEOUT_MS,
        'XLSX fallback Markdown conversion timed out after 60 seconds',
      );
      const markdown = cleanMarkdown(String(converted.value ?? ''));
      if (!markdown) throw new Error('officeparser returned empty Markdown');
      assertMarkdownLimit(markdown, 'XLSX');
      const warnings = [
        `ExcelJS parsing failed; used officeparser fallback: ${errorMessage(primaryError)}`,
      ];
      return {
        markdown,
        anchors: [{ type: 'document', offsetStart: 0, offsetEnd: markdown.length }],
        assets: [],
        warnings,
        stats: { characters: markdown.length },
        structure: createSectionedMarkdownStructure(markdown, 'xlsx', warnings),
      };
    } catch (fallbackError) {
      throw new Error(
        `XLSX parsing failed (ExcelJS: ${errorMessage(primaryError)}; officeparser: ${errorMessage(fallbackError)})`,
      );
    }
  }
}

function collectSheetCells(sheet: ExcelJS.Worksheet, warnings: string[]): SheetCell[] {
  const cells: SheetCell[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
      if (columnNumber > MAX_XLSX_COLUMNS) {
        throw new ParserLimitError(
          `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_COLUMNS}-column limit`,
        );
      }
      if (cell.isMerged && cell.master.address !== cell.address) return;
      const value = cellToString(cell.value, sheet.name, cell.address, warnings);
      if (!value) return;
      cells.push({ row: rowNumber, column: columnNumber, value });
    });
  });
  return cells;
}

function worksheetRegions(sheet: ExcelJS.Worksheet, cells: SheetCell[]): DataRegion[] {
  const explicit: DataRegion[] = [];
  const claimed = new Set<string>();
  const tables = sheet.getTables() as unknown as Array<{
    name: string;
    ref?: string;
    model?: { tableRef?: string };
  }>;
  for (const table of tables) {
    const bounds = parseCellRange(table.model?.tableRef ?? table.ref);
    if (!bounds) continue;
    const region = createDataRegion(
      sheet.name,
      table.name,
      bounds.rowStart,
      bounds.rowEnd,
      bounds.columnStart,
      bounds.columnEnd,
      cells,
    );
    if (!region) continue;
    explicit.push(region);
    for (const cell of cells) {
      if (cellInBounds(cell, bounds)) claimed.add(cellKey(cell.row, cell.column));
    }
  }

  const inferred = inferDataRegions(
    sheet.name,
    cells.filter((cell) => !claimed.has(cellKey(cell.row, cell.column))),
  );
  return [...explicit, ...inferred].sort(
    (left, right) => left.rowStart - right.rowStart || left.columnStart - right.columnStart,
  );
}

function inferDataRegions(sheet: string, cells: SheetCell[]): DataRegion[] {
  const regions: DataRegion[] = [];
  const rows = groupContiguous([...new Set(cells.map((cell) => cell.row))]);
  for (const rowGroup of rows) {
    const rowSet = new Set(rowGroup);
    const rowCells = cells.filter((cell) => rowSet.has(cell.row));
    const columns = groupContiguous([...new Set(rowCells.map((cell) => cell.column))]);
    for (const columnGroup of columns) {
      const columnSet = new Set(columnGroup);
      const regionCells = rowCells.filter((cell) => columnSet.has(cell.column));
      if (regionCells.length === 0) continue;
      const rowStart = Math.min(...regionCells.map((cell) => cell.row));
      const rowEnd = Math.max(...regionCells.map((cell) => cell.row));
      const columnStart = Math.min(...regionCells.map((cell) => cell.column));
      const columnEnd = Math.max(...regionCells.map((cell) => cell.column));
      const region = createDataRegion(
        sheet,
        undefined,
        rowStart,
        rowEnd,
        columnStart,
        columnEnd,
        regionCells,
      );
      if (region) regions.push(region);
    }
  }
  return regions;
}

function createDataRegion(
  sheet: string,
  name: string | undefined,
  rowStart: number,
  rowEnd: number,
  columnStart: number,
  columnEnd: number,
  cells: SheetCell[],
): DataRegion | undefined {
  const width = columnEnd - columnStart + 1;
  const height = rowEnd - rowStart + 1;
  if (width <= 0 || height <= 0) return undefined;
  if (width * height > MAX_XLSX_CELLS) {
    throw new ParserLimitError(
      `XLSX range ${a1Range(rowStart, columnStart, rowEnd, columnEnd)} is too large`,
    );
  }
  const values = new Map(cells.map((cell) => [cellKey(cell.row, cell.column), cell.value]));
  const rows = Array.from({ length: height }, (_, rowOffset) =>
    Array.from(
      { length: width },
      (_, columnOffset) =>
        values.get(cellKey(rowStart + rowOffset, columnStart + columnOffset)) ?? '',
    ),
  );
  if (!rows.some((row) => row.some(Boolean))) return undefined;
  const range = a1Range(rowStart, columnStart, rowEnd, columnEnd);
  return {
    id: `${sheet}:${range}`,
    name,
    sheet,
    rowStart,
    rowEnd,
    columnStart,
    columnEnd,
    range,
    rows,
  };
}

function regionSection(
  region: DataRegion,
  sheetIndex: number,
  regionIndex: number,
): WorksheetSection {
  const heading = region.name
    ? `### Table: ${region.name} (${region.range})`
    : `### Range ${region.range}`;
  return {
    id: `sheet-${sheetIndex}-region-${regionIndex}`,
    sheet: region.sheet,
    rowStart: region.rowStart,
    rowEnd: region.rowEnd,
    range: region.range,
    markdown: cleanMarkdown(
      [`## Sheet: ${region.sheet}`, heading, toMarkdownTable(region.rows)].join('\n\n'),
    ),
  };
}

function groupContiguous(values: number[]): number[][] {
  const groups: number[][] = [];
  for (const value of [...values].sort((left, right) => left - right)) {
    const current = groups.at(-1);
    if (!current || value > (current.at(-1) ?? value) + 1) groups.push([value]);
    else current.push(value);
  }
  return groups;
}

function cellInBounds(
  cell: SheetCell,
  bounds: {
    rowStart: number;
    rowEnd: number;
    columnStart: number;
    columnEnd: number;
  },
): boolean {
  return (
    cell.row >= bounds.rowStart &&
    cell.row <= bounds.rowEnd &&
    cell.column >= bounds.columnStart &&
    cell.column <= bounds.columnEnd
  );
}

function parseCellRange(value: string | undefined):
  | {
      rowStart: number;
      rowEnd: number;
      columnStart: number;
      columnEnd: number;
    }
  | undefined {
  if (!value) return undefined;
  const range = value.slice(value.lastIndexOf('!') + 1).replaceAll('$', '');
  const [startValue, endValue = startValue] = range.split(':');
  const start = parseCellAddress(startValue);
  const end = parseCellAddress(endValue);
  if (!start || !end) return undefined;
  return {
    rowStart: Math.min(start.row, end.row),
    rowEnd: Math.max(start.row, end.row),
    columnStart: Math.min(start.column, end.column),
    columnEnd: Math.max(start.column, end.column),
  };
}

function parseCellAddress(value: string | undefined):
  | {
      row: number;
      column: number;
    }
  | undefined {
  const match = value?.match(/^([A-Z]+)(\d+)$/iu);
  if (!match) return undefined;
  const column = columnNumber(match[1] ?? '');
  const row = Number(match[2]);
  return column > 0 && Number.isInteger(row) && row > 0 ? { row, column } : undefined;
}

function a1Range(rowStart: number, columnStart: number, rowEnd: number, columnEnd: number): string {
  const start = `${columnName(columnStart)}${rowStart}`;
  const end = `${columnName(columnEnd)}${rowEnd}`;
  return start === end ? start : `${start}:${end}`;
}

function columnName(column: number): string {
  let value = column;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

async function worksheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const workbook = zip.file('xl/workbook.xml');
  const relationships = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbook || !relationships) return new Map();
  const [workbookXml, relationshipsXml] = await Promise.all([
    readZipText(workbook, 'XLSX', MAX_WORKSHEET_XML_BYTES),
    readZipText(relationships, 'XLSX', MAX_WORKSHEET_XML_BYTES),
  ]);
  const relationshipMap = relationshipTargets(
    parseXml(relationshipsXml, 'XLSX workbook relationships'),
    'worksheet',
  );
  const paths = new Map<string, string>();
  for (const sheet of elementsByLocalName(parseXml(workbookXml, 'XLSX workbook'), 'sheet')) {
    const name = sheet.getAttribute('name');
    const relationshipId = relationshipAttribute(sheet, 'id');
    const target = relationshipId ? relationshipMap.get(relationshipId) : undefined;
    if (name && target) paths.set(name, resolveRelationshipTarget('xl/workbook.xml', target));
  }
  return paths;
}

async function extractWorksheetCharts(
  zip: JSZip,
  worksheetPath: string,
  sheet: string,
  sheetIndex: number,
): Promise<ChartExtraction> {
  const worksheet = zip.file(worksheetPath);
  if (!worksheet) return { sections: [], enrichments: [] };
  const worksheetXml = await readZipText(worksheet, 'XLSX', MAX_WORKSHEET_XML_BYTES);
  const worksheetDocument = parseXml(worksheetXml, `XLSX worksheet ${sheet}`);
  const drawing = firstDescendant(worksheetDocument, 'drawing');
  const relationshipId = drawing ? relationshipAttribute(drawing, 'id') : undefined;
  if (!relationshipId) return { sections: [], enrichments: [] };
  const worksheetRelationships = await packageRelationships(zip, worksheetPath);
  const drawingTarget = worksheetRelationships.get(relationshipId);
  if (!drawingTarget) return { sections: [], enrichments: [] };
  const drawingPath = resolveRelationshipTarget(worksheetPath, drawingTarget);
  const drawingFile = zip.file(drawingPath);
  if (!drawingFile) return { sections: [], enrichments: [] };
  const drawingDocument = parseXml(
    await readZipText(drawingFile, 'XLSX', MAX_WORKSHEET_XML_BYTES),
    `XLSX drawing ${drawingPath}`,
  );
  const drawingRelationships = await packageRelationships(zip, drawingPath);
  const sections: WorksheetSection[] = [];
  const enrichments: ImageEnrichment[] = [];
  const anchors = elementsByLocalName(drawingDocument, 'twoCellAnchor').concat(
    elementsByLocalName(drawingDocument, 'oneCellAnchor'),
  );
  for (const [index, anchor] of anchors.entries()) {
    const chart = firstDescendant(anchor, 'chart');
    const chartRelationshipId = chart ? relationshipAttribute(chart, 'id') : undefined;
    const chartTarget = chartRelationshipId
      ? drawingRelationships.get(chartRelationshipId)
      : undefined;
    if (!chartTarget) continue;
    const chartPath = resolveRelationshipTarget(drawingPath, chartTarget);
    const chartFile = zip.file(chartPath);
    if (!chartFile) continue;
    const chartData = parseChartXml(
      await readZipText(chartFile, 'XLSX', MAX_WORKSHEET_XML_BYTES),
      index + 1,
    );
    const bounds = drawingAnchorRange(anchor);
    const range = bounds
      ? a1Range(bounds.rowStart, bounds.columnStart, bounds.rowEnd, bounds.columnEnd)
      : 'A1';
    const rowStart = bounds?.rowStart ?? 1;
    const rowEnd = bounds?.rowEnd ?? rowStart;
    const figureId = `sheet-${sheetIndex}-chart-${index + 1}-f1`;
    const marker = `Chart analysis: ${chartData.summary}`;
    sections.push({
      id: `sheet-${sheetIndex}-chart-${index + 1}`,
      sheet,
      rowStart,
      rowEnd,
      range,
      markdown: cleanMarkdown(
        [
          `## Sheet: ${sheet}`,
          `### Chart: ${chartData.title} (${range})`,
          blockquote(marker),
          chartData.rows.length > 1 ? toMarkdownTable(chartData.rows) : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
    });
    enrichments.push({ marker, source: 'derived', kind: 'figure', figureId });
  }
  return { sections, enrichments };
}

async function packageRelationships(zip: JSZip, sourcePath: string): Promise<Map<string, string>> {
  const path = posix.join(posix.dirname(sourcePath), '_rels', `${posix.basename(sourcePath)}.rels`);
  const file = zip.file(path);
  if (!file) return new Map();
  const xml = await readZipText(file, 'XLSX', MAX_WORKSHEET_XML_BYTES);
  return relationshipTargets(parseXml(xml, `XLSX relationships for ${sourcePath}`));
}

async function removeChartAnchors(zip: JSZip): Promise<Uint8Array> {
  const serializer = new XMLSerializer();
  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !/^xl\/drawings\/drawing\d+\.xml$/iu.test(path)) continue;
    const document = parseXml(
      await readZipText(file, 'XLSX', MAX_WORKSHEET_XML_BYTES),
      `XLSX drawing ${path}`,
    );
    let changed = false;
    const anchors = elementsByLocalName(document, 'twoCellAnchor').concat(
      elementsByLocalName(document, 'oneCellAnchor'),
    );
    for (const anchor of anchors) {
      if (!firstDescendant(anchor, 'chart')) continue;
      anchor.parentNode?.removeChild(anchor);
      changed = true;
    }
    if (changed) zip.file(path, serializer.serializeToString(document));
  }
  return withTimeout(
    zip.generateAsync({ type: 'uint8array' }),
    PARSE_TIMEOUT_MS,
    'XLSX chart compatibility normalization timed out after 60 seconds',
  );
}

function relationshipTargets(document: XmlDocument, kind?: string): Map<string, string> {
  const targets = new Map<string, string>();
  for (const relationship of elementsByLocalName(document, 'Relationship')) {
    const id = relationship.getAttribute('Id');
    const target = relationship.getAttribute('Target');
    const type = relationship.getAttribute('Type');
    if (id && target && (!kind || type?.endsWith(`/${kind}`))) targets.set(id, target);
  }
  return targets;
}

function parseChartXml(
  xml: string,
  ordinal: number,
): { title: string; summary: string; rows: string[][] } {
  const document = parseXml(xml, `XLSX chart ${ordinal}`);
  const titleNode = firstDescendant(document, 'title');
  const title = drawingText(titleNode).trim() || `Chart ${ordinal}`;
  const series = elementsByLocalName(document, 'ser').map((element, index) => {
    const name = cacheValues(firstDescendant(element, 'tx'))[0] ?? `Series ${index + 1}`;
    const categoryNode = firstDescendant(element, 'cat') ?? firstDescendant(element, 'xVal');
    const valueNode = firstDescendant(element, 'val') ?? firstDescendant(element, 'yVal');
    return {
      name,
      categories: cacheValues(categoryNode),
      values: cacheValues(valueNode),
    };
  });
  const rowCount = Math.max(0, ...series.map((item) => item.values.length));
  const rows =
    series.length === 0 || rowCount === 0
      ? []
      : [
          ['Category', ...series.map((item) => item.name)],
          ...Array.from({ length: rowCount }, (_, index) => [
            series[0]?.categories[index] ?? String(index + 1),
            ...series.map((item) => item.values[index] ?? ''),
          ]),
        ];
  const summaryValues = rows
    .slice(1, 6)
    .map((row) => row.join(' | '))
    .join('; ');
  return {
    title,
    summary: summaryValues ? `${title}. ${summaryValues}` : title,
    rows,
  };
}

function cacheValues(parent: XmlElement | undefined): string[] {
  if (!parent) return [];
  const cache =
    firstDescendant(parent, 'strCache') ??
    firstDescendant(parent, 'numCache') ??
    firstDescendant(parent, 'multiLvlStrCache');
  if (!cache) {
    const directValue = firstDescendant(parent, 'v')?.textContent?.trim();
    return directValue ? [directValue] : [];
  }
  return elementsByLocalName(cache, 'pt')
    .map((point) => ({
      index: Number(point.getAttribute('idx') ?? 0),
      value: firstDescendant(point, 'v')?.textContent?.trim() ?? '',
    }))
    .sort((left, right) => left.index - right.index)
    .map((point) => point.value);
}

function drawingAnchorRange(anchor: XmlElement):
  | {
      rowStart: number;
      rowEnd: number;
      columnStart: number;
      columnEnd: number;
    }
  | undefined {
  const from = firstDirectChild(anchor, 'from');
  if (!from) return undefined;
  const start = markerCell(from);
  if (!start) return undefined;
  const to = firstDirectChild(anchor, 'to');
  const end = to ? markerCell(to) : undefined;
  return {
    rowStart: start.row,
    rowEnd: Math.max(start.row, end?.row ?? start.row),
    columnStart: start.column,
    columnEnd: Math.max(start.column, end?.column ?? start.column),
  };
}

function markerCell(marker: XmlElement): { row: number; column: number } | undefined {
  const row = Number(firstDirectChild(marker, 'row')?.textContent ?? Number.NaN);
  const column = Number(firstDirectChild(marker, 'col')?.textContent ?? Number.NaN);
  return Number.isInteger(row) && Number.isInteger(column)
    ? { row: row + 1, column: column + 1 }
    : undefined;
}

function workbookImageBytes(image: ExcelJS.Image | undefined): Uint8Array | undefined {
  if (!image) return undefined;
  if (image.buffer) return new Uint8Array(image.buffer);
  if (image.base64) {
    const encoded = image.base64.includes(',') ? image.base64.split(',').at(-1) : image.base64;
    return encoded ? new Uint8Array(Buffer.from(encoded, 'base64')) : undefined;
  }
  return undefined;
}

function imageCellRange(range: ExcelJS.ImageRange): {
  rowStart: number;
  rowEnd: number;
  range: string;
} {
  const startColumn = Math.floor(range.tl.col) + 1;
  const startRow = Math.floor(range.tl.row) + 1;
  const endColumn = range.br ? Math.max(startColumn, Math.ceil(range.br.col)) : startColumn;
  const endRow = range.br ? Math.max(startRow, Math.ceil(range.br.row)) : startRow;
  return {
    rowStart: startRow,
    rowEnd: endRow,
    range: a1Range(startRow, startColumn, endRow, endColumn),
  };
}

function worksheetNearbyText(sheet: ExcelJS.Worksheet): string {
  const values: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (values.join(' ').length >= 2_000) return;
      const value = cell.text.trim();
      if (value) values.push(value);
    });
  });
  return values.join(' ').slice(0, 2_000);
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
  parent: XmlDocument | XmlElement | undefined,
  localName: string,
): XmlElement | undefined {
  return parent ? elementsByLocalName(parent, localName)[0] : undefined;
}

function childElements(parent: XmlElement): XmlElement[] {
  return Array.from(parent.childNodes).filter((node): node is XmlElement => node.nodeType === 1);
}

function firstDirectChild(parent: XmlElement, localName: string): XmlElement | undefined {
  return childElements(parent).find((element) => element.localName === localName);
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

function drawingText(element: XmlElement | undefined): string {
  if (!element) return '';
  return elementsByLocalName(element, 't')
    .map((item) => item.textContent ?? '')
    .join(' ');
}

function mimeTypeForExtension(extension: string): string {
  const normalized = extension.toLowerCase();
  if (normalized === 'jpg' || normalized === 'jpeg') return 'image/jpeg';
  if (normalized === 'gif') return 'image/gif';
  if (normalized === 'webp') return 'image/webp';
  return 'image/png';
}

function blockquote(value: string): string {
  return value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function normalizeMarker(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

async function preflightAndNormalizeXlsx(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await loadOfficePackage(bytes, 'XLSX');
  const worksheets = Object.entries(zip.files).filter(
    ([path, file]) => !file.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(path),
  );
  if (worksheets.length === 0) throw new Error('XLSX package contains no worksheets');
  if (worksheets.length > MAX_XLSX_SHEETS) {
    throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_SHEETS}-sheet limit`);
  }

  let totalCells = 0;
  for (const [path, file] of worksheets) {
    const xml = await readZipText(file, 'XLSX', MAX_WORKSHEET_XML_BYTES);
    const dimensions = xml.match(
      /<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref="(?:[^:"]+:)?([A-Z]+)(\d+)"/i,
    );
    if (dimensions) {
      const column = columnNumber(dimensions[1] ?? '');
      const row = Number(dimensions[2] ?? 0);
      if (row > MAX_XLSX_ROWS_PER_SHEET) {
        throw new ParserLimitError(`${path} exceeds the ${MAX_XLSX_ROWS_PER_SHEET}-row limit`);
      }
      if (column > MAX_XLSX_COLUMNS) {
        throw new ParserLimitError(`${path} exceeds the ${MAX_XLSX_COLUMNS}-column limit`);
      }
    }
    const cells = xml.match(/<(?:[A-Za-z_][\w.-]*:)?c(?:\s|>)/g)?.length ?? 0;
    totalCells += cells;
    if (totalCells > MAX_XLSX_CELLS) {
      throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_CELLS}-cell limit`);
    }
  }

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !/^xl\/.*\.xml$/i.test(path)) continue;
    const xml = await readZipText(file, 'XLSX', 100 * 1024 * 1024);
    const normalized = normalizeSpreadsheetNamespace(xml);
    if (normalized !== xml) zip.file(path, normalized);
  }
  return withTimeout(
    zip.generateAsync({ type: 'uint8array' }),
    PARSE_TIMEOUT_MS,
    'XLSX package normalization timed out after 60 seconds',
  );
}

function normalizeSpreadsheetNamespace(xml: string): string {
  const namespace = xml.match(
    /xmlns:([A-Za-z_][\w.-]*)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/,
  );
  const prefix = namespace?.[1];
  if (!prefix) return xml;
  const qualifiedTag = new RegExp(`(<\\/?)(?:${escapeRegExp(prefix)}):`, 'g');
  return xml
    .replace(qualifiedTag, '$1')
    .replace(namespace[0], 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cellToString(
  value: ExcelJS.CellValue,
  sheetName: string,
  address: string,
  warnings: string[],
): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return value.toISOString();
  if ('error' in value) return value.error;
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('hyperlink' in value) return `[${value.text}](${value.hyperlink})`;
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result != null) return cellToString(value.result, sheetName, address, warnings);
    if (warnings.length < MAX_FORMULA_WARNINGS) {
      warnings.push(`Formula ${sheetName}!${address} has no cached result`);
    }
    const formula = 'formula' in value ? value.formula : value.sharedFormula;
    return formula ? `=${formula}` : '';
  }
  return String(value);
}

function joinSections(sections: WorksheetSection[]): {
  markdown: string;
  anchors: SourceAnchor[];
  structuredSections: StructuredMarkdownSection[];
} {
  const markdown = sections.map((section) => section.markdown).join('\n\n');
  const anchors: SourceAnchor[] = [];
  const structuredSections: StructuredMarkdownSection[] = [];
  let offset = 0;
  for (const [index, section] of sections.entries()) {
    anchors.push({
      type: 'sheet',
      sheet: section.sheet,
      rowStart: section.rowStart,
      rowEnd: section.rowEnd,
      range: section.range,
      offsetStart: offset,
      offsetEnd: offset + section.markdown.length,
    });
    structuredSections.push({
      id: section.id || `sheet-${index + 1}`,
      location: {
        type: 'sheet',
        sheet: section.sheet,
        rowStart: section.rowStart,
        rowEnd: section.rowEnd,
        range: section.range,
      },
      markdown: section.markdown,
      offsetStart: offset,
    });
    offset += section.markdown.length + 2;
  }
  return { markdown, anchors, structuredSections };
}

function columnNumber(column: string): number {
  return [...column.toUpperCase()].reduce(
    (value, character) => value * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function assertMarkdownLimit(markdown: string, format: string): void {
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new ParserLimitError(`${format} Markdown exceeds ${MAX_MARKDOWN_CHARACTERS} characters`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
