import { describe, expect, it } from 'vitest';
import {
  getStructuredPage,
  parseStructuredDocument,
  type StructuredDocumentV1,
} from './structured-document';

describe('parseStructuredDocument', () => {
  it('upgrades persisted PDF v1 structures to the generic v2 model', () => {
    const legacy: StructuredDocumentV1 = {
      version: 1,
      format: 'pdf',
      pages: [
        {
          page: 2,
          width: 600,
          height: 800,
          classification: 'mixed',
          textCharacters: 12,
          textCoverage: 0.1,
          imageCount: 1,
          ocrApplied: false,
          visionAnalyzedImages: 1,
          elements: [
            {
              id: 'p2-e1',
              kind: 'paragraph',
              page: 2,
              order: 1,
              text: 'Legacy content',
              markdown: 'Legacy content',
              offsetStart: 10,
              offsetEnd: 24,
              searchable: true,
              source: 'native',
              sectionPath: ['Legacy'],
            },
          ],
        },
      ],
      tables: [
        {
          id: 'p2-t1',
          page: 2,
          rows: [['Name', 'Value']],
          markdown: '| Name | Value |',
        },
      ],
      quality: {
        status: 'pass',
        score: 100,
        reasons: [],
        scannedPages: 0,
        unprocessedScannedPages: 0,
        lowConfidenceOcrPages: 0,
        emptySearchablePages: 0,
        unanalyzedVisuals: 0,
      },
    };

    const structure = parseStructuredDocument(JSON.stringify(legacy));

    expect(structure).toMatchObject({
      version: 2,
      format: 'pdf',
      quality: {
        metrics: {
          scannedPages: 0,
          unanalyzedVisuals: 0,
        },
      },
    });
    expect(getStructuredPage(structure!, 2)).toMatchObject({
      id: 'page-2',
      location: { type: 'page', page: 2 },
      elements: [
        {
          id: 'p2-e1',
          location: { type: 'page', page: 2 },
        },
      ],
    });
    expect(structure?.tables[0]).toMatchObject({
      id: 'p2-t1',
      location: { type: 'page', page: 2 },
    });
  });

  it('rejects unknown or malformed structure versions', () => {
    expect(parseStructuredDocument('{"version":3,"format":"pdf"}')).toBeUndefined();
    expect(parseStructuredDocument('{broken')).toBeUndefined();
  });
});
