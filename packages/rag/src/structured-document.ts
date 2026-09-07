export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DocumentFormat = 'pdf' | 'markdown' | 'text' | 'docx' | 'pptx' | 'xlsx';

export type DocumentLocation =
  | { type: 'document' }
  | { type: 'section'; heading?: string }
  | { type: 'page'; page: number }
  | { type: 'slide'; slide: number }
  | {
      type: 'sheet';
      sheet: string;
      rowStart?: number;
      rowEnd?: number;
      range?: string;
    };

export type PdfPageClassification = 'native' | 'scanned' | 'mixed';

export type StructuredElementKind =
  'heading' | 'paragraph' | 'list' | 'code' | 'table' | 'figure' | 'caption' | 'header' | 'footer';

export type StructuredElementSource = 'native' | 'ocr' | 'vision' | 'derived';

export type DocumentQualityStatus = 'pass' | 'review';

export type DocumentQualityMetric = number | string | boolean;

export type DocumentQualityReport = {
  status: DocumentQualityStatus;
  score: number;
  reasons: string[];
  metrics: Record<string, DocumentQualityMetric>;
};

export type StructuredDocumentElement = {
  id: string;
  kind: StructuredElementKind;
  location: DocumentLocation;
  order: number;
  text: string;
  markdown: string;
  offsetStart: number;
  offsetEnd: number;
  searchable: boolean;
  source: StructuredElementSource;
  sectionPath: string[];
  bbox?: BoundingBox;
  confidence?: number;
  tableId?: string;
  figureId?: string;
  assetFilename?: string;
};

export type StructuredDocumentTable = {
  id: string;
  location: DocumentLocation;
  rows: string[][];
  markdown: string;
};

export type StructuredDocumentUnit = {
  id: string;
  location: DocumentLocation;
  width?: number;
  height?: number;
  classification?: string;
  textCharacters?: number;
  textCoverage?: number;
  imageCount?: number;
  ocrApplied?: boolean;
  ocrConfidence?: number;
  visionAnalyzedImages?: number;
  elements: StructuredDocumentElement[];
  metadata?: Record<string, unknown>;
};

export type StructuredDocumentPage = StructuredDocumentUnit & {
  location: Extract<DocumentLocation, { type: 'page' }>;
  width: number;
  height: number;
  classification: PdfPageClassification;
  textCharacters: number;
  textCoverage: number;
  imageCount: number;
  ocrApplied: boolean;
  visionAnalyzedImages: number;
};

export type StructuredDocument = {
  version: 2;
  format: DocumentFormat;
  units: StructuredDocumentUnit[];
  tables: StructuredDocumentTable[];
  quality: DocumentQualityReport;
};

export type StructuredDocumentV1Element = Omit<StructuredDocumentElement, 'location'> & {
  page: number;
};

export type StructuredDocumentV1Table = Omit<StructuredDocumentTable, 'location'> & {
  page: number;
};

export type StructuredDocumentV1Page = Omit<
  StructuredDocumentPage,
  'id' | 'location' | 'elements'
> & {
  page: number;
  elements: StructuredDocumentV1Element[];
};

export type StructuredDocumentV1 = {
  version: 1;
  format: 'pdf';
  pages: StructuredDocumentV1Page[];
  tables: StructuredDocumentV1Table[];
  quality: {
    status: DocumentQualityStatus;
    score: number;
    reasons: string[];
    scannedPages: number;
    unprocessedScannedPages: number;
    lowConfidenceOcrPages: number;
    emptySearchablePages: number;
    unanalyzedVisuals: number;
  };
};

export type PersistedStructuredDocument = StructuredDocument | StructuredDocumentV1;

export function parseStructuredDocument(value: string | unknown): StructuredDocument | undefined {
  let candidate: unknown = value;
  if (typeof value === 'string') {
    try {
      candidate = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (isStructuredDocument(candidate)) return candidate;
  if (isStructuredDocumentV1(candidate)) return upgradeStructuredDocumentV1(candidate);
  return undefined;
}

export function isStructuredDocument(value: unknown): value is StructuredDocument {
  if (!isRecord(value)) return false;
  return (
    value.version === 2 &&
    isDocumentFormat(value.format) &&
    Array.isArray(value.units) &&
    value.units.every(isStructuredDocumentUnit) &&
    Array.isArray(value.tables) &&
    value.tables.every(isStructuredDocumentTable) &&
    isDocumentQualityReport(value.quality)
  );
}

export function upgradeStructuredDocumentV1(value: StructuredDocumentV1): StructuredDocument {
  return {
    version: 2,
    format: 'pdf',
    units: value.pages.map((page) => {
      const location = pageLocation(page.page);
      return {
        id: `page-${page.page}`,
        location,
        width: page.width,
        height: page.height,
        classification: page.classification,
        textCharacters: page.textCharacters,
        textCoverage: page.textCoverage,
        imageCount: page.imageCount,
        ocrApplied: page.ocrApplied,
        ocrConfidence: page.ocrConfidence,
        visionAnalyzedImages: page.visionAnalyzedImages,
        elements: page.elements.map((element) =>
          upgradeStructuredDocumentV1Element(element, location),
        ),
      };
    }),
    tables: value.tables.map(({ page, ...table }) => ({
      ...table,
      location: pageLocation(page),
    })),
    quality: {
      status: value.quality.status,
      score: value.quality.score,
      reasons: [...value.quality.reasons],
      metrics: {
        scannedPages: value.quality.scannedPages,
        unprocessedScannedPages: value.quality.unprocessedScannedPages,
        lowConfidenceOcrPages: value.quality.lowConfidenceOcrPages,
        emptySearchablePages: value.quality.emptySearchablePages,
        unanalyzedVisuals: value.quality.unanalyzedVisuals,
      },
    },
  };
}

function upgradeStructuredDocumentV1Element(
  element: StructuredDocumentV1Element,
  location: Extract<DocumentLocation, { type: 'page' }>,
): StructuredDocumentElement {
  return {
    id: element.id,
    kind: element.kind,
    location,
    order: element.order,
    text: element.text,
    markdown: element.markdown,
    offsetStart: element.offsetStart,
    offsetEnd: element.offsetEnd,
    searchable: element.searchable,
    source: element.source,
    sectionPath: [...element.sectionPath],
    bbox: element.bbox,
    confidence: element.confidence,
    tableId: element.tableId,
    figureId: element.figureId,
    assetFilename: element.assetFilename,
  };
}

export function pageLocation(page: number): Extract<DocumentLocation, { type: 'page' }> {
  return { type: 'page', page };
}

export function getStructuredPage(
  structure: StructuredDocument,
  page: number,
): StructuredDocumentPage | undefined {
  const unit = structure.units.find(
    (candidate) => candidate.location.type === 'page' && candidate.location.page === page,
  );
  return unit && isStructuredDocumentPage(unit) ? unit : undefined;
}

export function structuredDocumentPages(structure: StructuredDocument): StructuredDocumentPage[] {
  return structure.units.filter(isStructuredDocumentPage);
}

export function sameDocumentLocation(left: DocumentLocation, right: DocumentLocation): boolean {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case 'document':
      return true;
    case 'section':
      return right.type === 'section' && left.heading === right.heading;
    case 'page':
      return right.type === 'page' && left.page === right.page;
    case 'slide':
      return right.type === 'slide' && left.slide === right.slide;
    case 'sheet':
      return (
        right.type === 'sheet' &&
        left.sheet === right.sheet &&
        left.rowStart === right.rowStart &&
        left.rowEnd === right.rowEnd &&
        left.range === right.range
      );
  }
}

function isStructuredDocumentV1(value: unknown): value is StructuredDocumentV1 {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.format === 'pdf' &&
    Array.isArray(value.pages) &&
    value.pages.every(isStructuredDocumentV1Page) &&
    Array.isArray(value.tables) &&
    value.tables.every(isStructuredDocumentV1Table) &&
    isStructuredDocumentV1Quality(value.quality)
  );
}

function isStructuredDocumentUnit(value: unknown): value is StructuredDocumentUnit {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isDocumentLocation(value.location) &&
    Array.isArray(value.elements) &&
    value.elements.every(isStructuredDocumentElement)
  );
}

function isStructuredDocumentPage(value: StructuredDocumentUnit): value is StructuredDocumentPage {
  return (
    value.location.type === 'page' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    isPdfPageClassification(value.classification) &&
    typeof value.textCharacters === 'number' &&
    typeof value.textCoverage === 'number' &&
    typeof value.imageCount === 'number' &&
    typeof value.ocrApplied === 'boolean' &&
    typeof value.visionAnalyzedImages === 'number'
  );
}

function isStructuredDocumentElement(value: unknown): value is StructuredDocumentElement {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isStructuredElementKind(value.kind) &&
    isDocumentLocation(value.location) &&
    typeof value.order === 'number' &&
    typeof value.text === 'string' &&
    typeof value.markdown === 'string' &&
    typeof value.offsetStart === 'number' &&
    typeof value.offsetEnd === 'number' &&
    typeof value.searchable === 'boolean' &&
    isStructuredElementSource(value.source) &&
    Array.isArray(value.sectionPath) &&
    value.sectionPath.every((item) => typeof item === 'string')
  );
}

function isStructuredDocumentTable(value: unknown): value is StructuredDocumentTable {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    isDocumentLocation(value.location) &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'),
    ) &&
    typeof value.markdown === 'string'
  );
}

function isDocumentQualityReport(value: unknown): value is DocumentQualityReport {
  if (!isRecord(value) || !isRecord(value.metrics)) return false;
  return (
    (value.status === 'pass' || value.status === 'review') &&
    typeof value.score === 'number' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string') &&
    Object.values(value.metrics).every(
      (metric) =>
        typeof metric === 'number' || typeof metric === 'string' || typeof metric === 'boolean',
    )
  );
}

function isStructuredDocumentV1Page(value: unknown): value is StructuredDocumentV1Page {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.page) &&
    typeof value.width === 'number' &&
    typeof value.height === 'number' &&
    isPdfPageClassification(value.classification) &&
    typeof value.textCharacters === 'number' &&
    typeof value.textCoverage === 'number' &&
    typeof value.imageCount === 'number' &&
    typeof value.ocrApplied === 'boolean' &&
    typeof value.visionAnalyzedImages === 'number' &&
    Array.isArray(value.elements) &&
    value.elements.every(isStructuredDocumentV1Element)
  );
}

function isStructuredDocumentV1Element(value: unknown): value is StructuredDocumentV1Element {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.page) &&
    typeof value.id === 'string' &&
    isStructuredElementKind(value.kind) &&
    typeof value.order === 'number' &&
    typeof value.text === 'string' &&
    typeof value.markdown === 'string' &&
    typeof value.offsetStart === 'number' &&
    typeof value.offsetEnd === 'number' &&
    typeof value.searchable === 'boolean' &&
    isStructuredElementSource(value.source) &&
    Array.isArray(value.sectionPath) &&
    value.sectionPath.every((item) => typeof item === 'string')
  );
}

function isStructuredDocumentV1Table(value: unknown): value is StructuredDocumentV1Table {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.page) &&
    typeof value.id === 'string' &&
    Array.isArray(value.rows) &&
    value.rows.every(
      (row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'),
    ) &&
    typeof value.markdown === 'string'
  );
}

function isStructuredDocumentV1Quality(value: unknown): value is StructuredDocumentV1['quality'] {
  if (!isRecord(value)) return false;
  return (
    (value.status === 'pass' || value.status === 'review') &&
    typeof value.score === 'number' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string') &&
    typeof value.scannedPages === 'number' &&
    typeof value.unprocessedScannedPages === 'number' &&
    typeof value.lowConfidenceOcrPages === 'number' &&
    typeof value.emptySearchablePages === 'number' &&
    typeof value.unanalyzedVisuals === 'number'
  );
}

function isDocumentLocation(value: unknown): value is DocumentLocation {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  switch (value.type) {
    case 'document':
      return true;
    case 'section':
      return value.heading === undefined || typeof value.heading === 'string';
    case 'page':
      return isPositiveInteger(value.page);
    case 'slide':
      return isPositiveInteger(value.slide);
    case 'sheet':
      return (
        typeof value.sheet === 'string' &&
        (value.rowStart === undefined || isPositiveInteger(value.rowStart)) &&
        (value.rowEnd === undefined || isPositiveInteger(value.rowEnd)) &&
        (value.range === undefined || typeof value.range === 'string')
      );
    default:
      return false;
  }
}

function isDocumentFormat(value: unknown): value is DocumentFormat {
  return (
    value === 'pdf' ||
    value === 'markdown' ||
    value === 'text' ||
    value === 'docx' ||
    value === 'pptx' ||
    value === 'xlsx'
  );
}

function isPdfPageClassification(value: unknown): value is PdfPageClassification {
  return value === 'native' || value === 'scanned' || value === 'mixed';
}

function isStructuredElementKind(value: unknown): value is StructuredElementKind {
  return (
    value === 'heading' ||
    value === 'paragraph' ||
    value === 'list' ||
    value === 'code' ||
    value === 'table' ||
    value === 'figure' ||
    value === 'caption' ||
    value === 'header' ||
    value === 'footer'
  );
}

function isStructuredElementSource(value: unknown): value is StructuredElementSource {
  return value === 'native' || value === 'ocr' || value === 'vision' || value === 'derived';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export type OcrBlock = {
  text: string;
  confidence: number;
  bbox?: BoundingBox;
};

export type OcrInput = {
  format: DocumentFormat;
  location: DocumentLocation;
  image: Uint8Array;
  width: number;
  height: number;
  tenantId?: string;
  runId?: string;
  assetId?: string;
};

export type OcrResult = {
  text: string;
  confidence: number;
  blocks: OcrBlock[];
};

export interface OcrEngine {
  recognize(input: OcrInput): Promise<OcrResult>;
}

export type VisionKind =
  'chart' | 'diagram' | 'table' | 'document' | 'photo' | 'decorative' | 'other';

export type VisionInput = {
  format: DocumentFormat;
  location: DocumentLocation;
  image: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  nearbyText: string;
  tenantId?: string;
  runId?: string;
  assetId?: string;
};

export type DocumentProcessingMetric = {
  operation: 'ocr' | 'vision';
  format: DocumentFormat;
  location: DocumentLocation;
  assetId?: string;
  provider: string;
  model?: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  cacheHit: boolean;
  metadata?: Record<string, unknown>;
};

export type DocumentProcessingObserver = (
  metric: DocumentProcessingMetric,
  context: { tenantId?: string; documentVersionId?: string },
) => void | Promise<void>;

export type VisionResult = {
  kind: VisionKind;
  description: string;
  searchable: boolean;
  confidence?: number;
};

export interface VisionEngine {
  analyze(input: VisionInput): Promise<VisionResult>;
}

/** @deprecated Use OcrBlock. */
export type PdfOcrBlock = OcrBlock;
/** @deprecated Use OcrInput. */
export type PdfOcrInput = OcrInput;
/** @deprecated Use OcrResult. */
export type PdfOcrResult = OcrResult;
/** @deprecated Use OcrEngine. */
export type PdfOcrEngine = OcrEngine;
/** @deprecated Use VisionKind. */
export type PdfVisionKind = VisionKind;
/** @deprecated Use VisionInput. */
export type PdfVisionInput = VisionInput;
/** @deprecated Use DocumentProcessingMetric. */
export type PdfProcessingMetric = DocumentProcessingMetric;
/** @deprecated Use DocumentProcessingObserver. */
export type PdfProcessingObserver = DocumentProcessingObserver;
/** @deprecated Use VisionResult. */
export type PdfVisionResult = VisionResult;
/** @deprecated Use VisionEngine. */
export type PdfVisionEngine = VisionEngine;
