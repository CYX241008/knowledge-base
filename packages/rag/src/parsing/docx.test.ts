import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DocumentProcessingMetric, OcrEngine, VisionEngine } from '../structured-document';
import { DocxDocumentParser } from './docx';

const fixture = resolve(process.cwd(), 'test-fixtures/parser-sample.docx');

describe('DocxDocumentParser', () => {
  it('preserves headings, lists, links, and table structure', async () => {
    const parser = new DocxDocumentParser();
    const result = await parser.parse({
      filename: 'parser-sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.markdown).toContain('# Knowledge Base Guide');
    expect(result.markdown).toContain('[operations handbook](https://example.com/handbook)');
    expect(result.markdown).toMatch(/-\s+Upload a source file/);
    expect(result.markdown).toContain('| Stage | Result |');
    expect(result.markdown).toContain('| Parse | Markdown |');
    expect(result.anchors[0]).toMatchObject({ type: 'heading', heading: 'Knowledge Base Guide' });
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ kind: 'image', mimeType: 'image/png' });
    expect(result.markdown).toContain('knowledge-asset://docx-image-001.png');
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'docx',
    });
    expect(result.structure?.tables[0]?.rows).toEqual([
      ['Stage', 'Result'],
      ['Parse', 'Markdown'],
      ['Index', 'Searchable'],
    ]);
    expect(
      result.structure?.units
        .flatMap((unit) => unit.elements)
        .some(
          (element) => element.kind === 'figure' && element.assetFilename === 'docx-image-001.png',
        ),
    ).toBe(true);
  });

  it('rejects empty DOCX input', async () => {
    await expect(
      new DocxDocumentParser().parse({
        filename: 'empty.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow('empty');
  });

  it('enriches embedded images with OCR and vision using section locations', async () => {
    const metrics: DocumentProcessingMetric[] = [];
    const ocrEngine: OcrEngine = {
      async recognize(input) {
        expect(input).toMatchObject({
          format: 'docx',
          location: { type: 'section', heading: 'Knowledge Base Guide' },
        });
        return {
          text: 'Embedded image text',
          confidence: 91,
          blocks: [],
        };
      },
    };
    const visionEngine: VisionEngine = {
      async analyze(input) {
        expect(input).toMatchObject({
          format: 'docx',
          location: { type: 'section', heading: 'Knowledge Base Guide' },
        });
        return {
          kind: 'diagram',
          description: 'The diagram shows a document ingestion flow.',
          searchable: true,
          confidence: 88,
        };
      },
    };
    const result = await new DocxDocumentParser({
      ocrEngine,
      ocrMinPixels: 1,
      visionEngine,
      visionMinPixels: 1,
      onProcessingMetric(metric) {
        metrics.push(metric);
      },
    }).parse({
      filename: 'parser-sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array(await readFile(fixture)),
      tenantId: '11111111-1111-4111-8111-111111111111',
      documentVersionId: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.markdown).toContain('OCR text: Embedded image text');
    expect(result.markdown).toContain(
      'Visual analysis: The diagram shows a document ingestion flow.',
    );
    expect(result.assets[0]?.anchor).toMatchObject({
      type: 'heading',
      heading: 'Knowledge Base Guide',
    });
    expect(
      result.structure?.units
        .flatMap((unit) => unit.elements)
        .filter((element) => element.source === 'ocr' || element.source === 'vision'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ocr', confidence: 91 }),
        expect.objectContaining({
          source: 'vision',
          kind: 'figure',
          figureId: 'docx-f1',
          confidence: 88,
        }),
      ]),
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        operation: 'ocr',
        format: 'docx',
        location: { type: 'section', heading: 'Knowledge Base Guide' },
      }),
      expect.objectContaining({
        operation: 'vision',
        format: 'docx',
        location: { type: 'section', heading: 'Knowledge Base Guide' },
      }),
    ]);
  });

  it('keeps the document usable when image analysis fails', async () => {
    const metrics: DocumentProcessingMetric[] = [];
    const result = await new DocxDocumentParser({
      visionEngine: {
        async analyze() {
          throw new Error('vision unavailable');
        },
      },
      visionMinPixels: 1,
      onProcessingMetric(metric) {
        metrics.push(metric);
      },
    }).parse({
      filename: 'parser-sample.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.markdown).toContain('# Knowledge Base Guide');
    expect(result.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('vision unavailable')]),
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        operation: 'vision',
        format: 'docx',
        status: 'failed',
      }),
    ]);
  });
});
