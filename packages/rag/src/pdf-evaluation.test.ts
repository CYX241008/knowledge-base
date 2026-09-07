import { describe, expect, it } from 'vitest';
import { evaluatePdfStructure } from './pdf-evaluation';
import type { StructuredDocument } from './structured-document';

describe('evaluatePdfStructure', () => {
  it('scores classification, text, tables, visuals, and coordinates', () => {
    const structure = {
      version: 1,
      format: 'pdf',
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
      tables: [{ id: 'p1-t1', page: 1, rows: [['Revenue', '100']], markdown: '' }],
      pages: [
        {
          page: 1,
          width: 100,
          height: 100,
          classification: 'mixed',
          textCharacters: 20,
          textCoverage: 0.2,
          imageCount: 1,
          ocrApplied: false,
          visionAnalyzedImages: 1,
          elements: [
            {
              id: 'p1-e1',
              kind: 'paragraph',
              page: 1,
              order: 1,
              text: 'Quarterly revenue',
              markdown: 'Quarterly revenue',
              offsetStart: 0,
              offsetEnd: 17,
              searchable: true,
              source: 'native',
              sectionPath: [],
              bbox: { x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
            },
            {
              id: 'p1-f1',
              kind: 'figure',
              page: 1,
              order: 2,
              text: 'Revenue increased',
              markdown: 'Revenue increased',
              offsetStart: 18,
              offsetEnd: 35,
              searchable: true,
              source: 'vision',
              sectionPath: [],
              bbox: { x: 0.1, y: 0.3, width: 0.5, height: 0.4 },
            },
          ],
        },
      ],
    } satisfies StructuredDocument;
    expect(
      evaluatePdfStructure(structure, [
        {
          page: 1,
          classification: 'mixed',
          requiredText: ['quarterly revenue'],
          expectedTableCells: ['100'],
          requiredVisualTerms: ['increased'],
          requireBoundingBoxes: true,
        },
      ]),
    ).toMatchObject({ passed: true, locatableElementRate: 1 });
  });
});
