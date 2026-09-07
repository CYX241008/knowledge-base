import type { SearchDocumentHit } from '@knowledge-base/contracts';
import type { StructuredDocument } from '@knowledge-base/rag';
import { describe, expect, it, vi } from 'vitest';
import type { AccessControlService } from '../access-control/access-control.service';
import type { AuthContext } from '../auth/auth-context';
import type { DocumentsService } from '../documents/documents.service';
import { DocumentToolsService } from './document-tools.service';

const auth: AuthContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  principalIds: ['user:22222222-2222-4222-8222-222222222222'],
  permissionKeys: [],
  mode: 'demo',
};

describe('DocumentToolsService', () => {
  it('reads an explicit XLSX range and preserves it in the synthetic source', async () => {
    const structure: StructuredDocument = {
      version: 2,
      format: 'xlsx',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [
        {
          id: 'sheet-1-region-1-t1',
          location: {
            type: 'sheet',
            sheet: 'Summary',
            rowStart: 1,
            rowEnd: 3,
            range: 'A1:B3',
          },
          rows: [
            ['Name', 'Value'],
            ['Alpha', '1'],
            ['Beta', '2'],
          ],
          markdown: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |',
        },
      ],
      units: [
        {
          id: 'sheet-1-region-1',
          location: {
            type: 'sheet',
            sheet: 'Summary',
            rowStart: 1,
            rowEnd: 3,
            range: 'A1:B3',
          },
          elements: [
            {
              id: 'sheet-1-region-1-e1',
              kind: 'table',
              location: {
                type: 'sheet',
                sheet: 'Summary',
                rowStart: 1,
                rowEnd: 3,
                range: 'A1:B3',
              },
              order: 1,
              text: 'Name | Value\nAlpha | 1\nBeta | 2',
              markdown: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |',
              offsetStart: 0,
              offsetEnd: 60,
              searchable: true,
              source: 'native',
              sectionPath: ['Summary'],
              tableId: 'sheet-1-region-1-t1',
            },
          ],
        },
      ],
    };
    const documents = {
      getStructure: vi.fn(async () => structure),
    } as unknown as DocumentsService;
    const accessControl = {
      assertDocumentRead: vi.fn(async () => undefined),
    } as unknown as AccessControlService;
    const service = new DocumentToolsService(documents, accessControl);
    const hit: SearchDocumentHit = {
      chunkId: '33333333-3333-4333-8333-333333333333',
      documentId: '44444444-4444-4444-8444-444444444444',
      documentVersionId: '55555555-5555-4555-8555-555555555555',
      title: 'Workbook',
      content: '| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n| Beta | 2 |',
      score: 1,
      source: {
        type: 'sheet',
        page: null,
        slide: null,
        sheet: 'Summary',
        rowStart: 1,
        rowEnd: 3,
        range: 'A1:B3',
        heading: null,
        offsetStart: 0,
        offsetEnd: 60,
      },
    };

    const result = await service.enrich(auth, 'Format E2E report: 读取 Summary!A1:B3 范围', [hit]);

    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'read_range',
          status: 'success',
          sheet: 'Summary',
          range: 'A1:B3',
        }),
      ]),
    );
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: expect.objectContaining({
            type: 'sheet',
            sheet: 'Summary',
            range: 'A1:B3',
          }),
        }),
      ]),
    );
    expect(result.hits).toHaveLength(1);
  });

  it('reads an explicit PPTX slide through read_location', async () => {
    const structure: StructuredDocument = {
      version: 2,
      format: 'pptx',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [],
      units: [
        {
          id: 'slide-2',
          location: { type: 'slide', slide: 2 },
          elements: [
            {
              id: 's2-e1',
              kind: 'paragraph',
              location: { type: 'slide', slide: 2 },
              order: 1,
              text: 'Deployment architecture',
              markdown: 'Deployment architecture',
              offsetStart: 20,
              offsetEnd: 43,
              searchable: true,
              source: 'native',
              sectionPath: ['Architecture'],
              bbox: { x: 0.1, y: 0.2, width: 0.7, height: 0.1 },
            },
          ],
        },
      ],
    };
    const service = serviceWithStructure(structure);
    const hit = searchHit({
      type: 'slide',
      slide: 1,
      heading: 'Architecture',
    });

    const result = await service.enrich(auth, '读取第 2 张幻灯片的上下文', [hit]);

    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'read_location',
          status: 'success',
          locationType: 'slide',
          slide: 2,
        }),
      ]),
    );
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: 'Deployment architecture',
          source: expect.objectContaining({ type: 'slide', slide: 2 }),
        }),
      ]),
    );
  });

  it('reads a DOCX section by heading through read_location', async () => {
    const structure: StructuredDocument = {
      version: 2,
      format: 'docx',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [],
      units: [
        {
          id: 'section-1',
          location: { type: 'section', heading: 'Deployment' },
          elements: [
            {
              id: 'docx-e1',
              kind: 'heading',
              location: { type: 'section', heading: 'Deployment' },
              order: 1,
              text: 'Deployment',
              markdown: '## Deployment',
              offsetStart: 0,
              offsetEnd: 13,
              searchable: true,
              source: 'native',
              sectionPath: ['Deployment'],
            },
            {
              id: 'docx-e2',
              kind: 'paragraph',
              location: { type: 'section', heading: 'Deployment' },
              order: 2,
              text: 'Use the production worker.',
              markdown: 'Use the production worker.',
              offsetStart: 15,
              offsetEnd: 41,
              searchable: true,
              source: 'native',
              sectionPath: ['Deployment'],
            },
          ],
        },
      ],
    };
    const service = serviceWithStructure(structure);
    const hit = searchHit({ type: 'heading', heading: 'Deployment' });

    const result = await service.enrich(auth, '读取章节 Deployment', [hit]);

    expect(result.toolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'read_location',
          status: 'success',
          locationType: 'section',
          heading: 'Deployment',
        }),
      ]),
    );
    expect(result.hits.some((item) => item.content.includes('production worker'))).toBe(true);
  });

  it('replaces a ranked page hit in place with the fuller page context', async () => {
    const structure: StructuredDocument = {
      version: 2,
      format: 'pdf',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [],
      units: [
        {
          id: 'page-1',
          location: { type: 'page', page: 1 },
          width: 612,
          height: 792,
          classification: 'native',
          textCharacters: 52,
          textCoverage: 1,
          imageCount: 0,
          ocrApplied: false,
          visionAnalyzedImages: 0,
          elements: [
            {
              id: 'p1-e1',
              kind: 'paragraph',
              location: { type: 'page', page: 1 },
              order: 1,
              text: 'This is the first page used for parser verification.',
              markdown: 'This is the first page used for parser verification.',
              offsetStart: 0,
              offsetEnd: 52,
              searchable: true,
              source: 'native',
              sectionPath: [],
            },
          ],
        },
      ],
    };
    const service = serviceWithStructure(structure);
    const first = searchHit({ type: 'page', page: 1 });
    first.content = 'This is the first page';
    const second = {
      ...searchHit({ type: 'document' }),
      chunkId: '66666666-6666-4666-8666-666666666666',
      documentId: '77777777-7777-4777-8777-777777777777',
      documentVersionId: '88888888-8888-4888-8888-888888888888',
      title: 'Other document',
    };

    const result = await service.enrich(auth, 'What is page 1 used for?', [first, second]);

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      documentId: first.documentId,
      content: 'This is the first page used for parser verification.',
      source: { type: 'page', page: 1 },
    });
    expect(result.hits[1]?.documentId).toBe(second.documentId);
  });
});

function serviceWithStructure(structure: StructuredDocument): DocumentToolsService {
  return new DocumentToolsService(
    {
      getStructure: vi.fn(async () => structure),
    } as unknown as DocumentsService,
    {
      assertDocumentRead: vi.fn(async () => undefined),
    } as unknown as AccessControlService,
  );
}

function searchHit(
  source: Partial<SearchDocumentHit['source']> & Pick<SearchDocumentHit['source'], 'type'>,
): SearchDocumentHit {
  return {
    chunkId: '33333333-3333-4333-8333-333333333333',
    documentId: '44444444-4444-4444-8444-444444444444',
    documentVersionId: '55555555-5555-4555-8555-555555555555',
    title: 'Document',
    content: 'Retrieved content',
    score: 1,
    source: {
      page: null,
      slide: null,
      sheet: null,
      rowStart: null,
      rowEnd: null,
      range: null,
      heading: null,
      offsetStart: 0,
      offsetEnd: 20,
      ...source,
    },
  };
}
