export type BoundingBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPageClassification = 'native' | 'scanned' | 'mixed';

export type StructuredElementKind =
  'heading' | 'paragraph' | 'table' | 'figure' | 'caption' | 'header' | 'footer';

export type StructuredElementSource = 'native' | 'ocr' | 'derived';

export type StructuredDocumentElement = {
  id: string;
  kind: StructuredElementKind;
  page: number;
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
  assetFilename?: string;
};

export type StructuredDocumentTable = {
  id: string;
  page: number;
  rows: string[][];
  markdown: string;
};

export type StructuredDocumentPage = {
  page: number;
  width: number;
  height: number;
  classification: PdfPageClassification;
  textCharacters: number;
  textCoverage: number;
  imageCount: number;
  ocrApplied: boolean;
  ocrConfidence?: number;
  elements: StructuredDocumentElement[];
};

export type StructuredDocument = {
  version: 1;
  format: 'pdf';
  pages: StructuredDocumentPage[];
  tables: StructuredDocumentTable[];
};

export type PdfOcrBlock = {
  text: string;
  confidence: number;
  bbox?: BoundingBox;
};

export type PdfOcrInput = {
  page: number;
  image: Uint8Array;
  width: number;
  height: number;
};

export type PdfOcrResult = {
  text: string;
  confidence: number;
  blocks: PdfOcrBlock[];
};

export interface PdfOcrEngine {
  recognize(input: PdfOcrInput): Promise<PdfOcrResult>;
}
