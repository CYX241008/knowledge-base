export type SourceAnchor = {
  type: 'document' | 'heading' | 'page' | 'slide' | 'sheet';
  page?: number;
  slide?: number;
  sheet?: string;
  rowStart?: number;
  rowEnd?: number;
  heading?: string;
  offsetStart: number;
  offsetEnd: number;
};
export type RetrievedChunk = {
  id: string;
  documentVersionId: string;
  content: string;
  score: number;
  anchor: SourceAnchor;
};
export type RetrievalQuery = {
  tenantId: string;
  principalIds: string[];
  text: string;
  limit: number;
};

export type ParsedAsset = {
  kind: 'image' | 'attachment';
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  anchor?: Omit<SourceAnchor, 'offsetStart' | 'offsetEnd'>;
};

export type ParseResult = {
  markdown: string;
  anchors: SourceAnchor[];
  assets: ParsedAsset[];
  warnings: string[];
  stats: { characters: number; pages?: number; slides?: number; sheets?: number };
};

export type ParseInput = { filename: string; mimeType: string; bytes: Uint8Array };

export interface DocumentParser {
  readonly name: string;
  readonly version: string;
  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean;
  parse(input: ParseInput): Promise<ParseResult>;
}

export type ParsedDocument = ParseResult & {
  parserName: string;
  parserVersion: string;
};
export interface Retriever {
  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}
export interface Reranker {
  rerank(query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]>;
}

export { CHUNKER_VERSION, chunkMarkdown } from './chunking/markdown';
export type { ChunkMarkdownOptions, MarkdownChunk } from './chunking/markdown';
export { assetReference, toMarkdownTable } from './parsing/parser-utils';
export { DocxDocumentParser } from './parsing/docx';
export { DocumentParserRegistry } from './parsing/document-parser-registry';
export { PdfDocumentParser } from './parsing/pdf';
export { PptxDocumentParser } from './parsing/pptx';
export {
  PlainTextDocumentParser,
  cleanMarkdown,
  extensionOf,
  headingAnchors,
} from './parsing/plain-text';
export { XlsxDocumentParser } from './parsing/xlsx';
export { DEFAULT_DOCUMENT_CHUNK_INDEX, ElasticsearchChunkIndex } from './retrieval/elasticsearch';
export type { KeywordIndexedChunk, KeywordSearchHit } from './retrieval/elasticsearch';
export { evaluateRag } from './evaluation';
export type {
  RagEvaluationCase,
  RagEvaluationCaseResult,
  RagEvaluationCategory,
  RagEvaluationObservation,
  RagEvaluationOptions,
  RagEvaluationRelevantChunk,
  RagEvaluationReport,
  RagEvaluationRetrievalDiagnostics,
  RagEvaluationStage,
} from './evaluation';
