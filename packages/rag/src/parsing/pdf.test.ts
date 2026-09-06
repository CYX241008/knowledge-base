import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PdfOcrEngine, PdfVisionEngine } from '../structured-document';
import { renderPdfPagePng } from './pdf-preview';
import { classifyPdfPage, PdfDocumentParser } from './pdf';

const fixture = resolve(process.cwd(), 'test-fixtures/parser-sample.pdf');

describe('PdfDocumentParser', () => {
  it('creates page boundaries, source anchors, and image assets', async () => {
    const parser = new PdfDocumentParser();
    const result = await parser.parse({
      filename: 'parser-sample.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.stats.pages).toBe(2);
    expect(result.markdown).toContain('## Page 1');
    expect(result.markdown).toContain('Knowledge Base PDF');
    expect(result.markdown).toContain('## Page 2');
    expect(result.markdown).toContain('Operations Checklist');
    const pageAnchors = result.anchors.filter((anchor) => !anchor.elementId);
    expect(pageAnchors).toHaveLength(2);
    expect(pageAnchors.map((anchor) => anchor.page)).toEqual([1, 2]);
    expect(result.markdown.slice(pageAnchors[1]?.offsetStart)).toMatch(/^## Page 2/);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      anchor: { type: 'page', page: 1 },
    });
    expect(result.markdown).toContain('knowledge-asset://pdf-image-p1-001.png');
    expect(result.structure).toMatchObject({
      version: 1,
      format: 'pdf',
      pages: [
        { page: 1, classification: 'mixed' },
        { page: 2, classification: 'native' },
      ],
    });
  }, 20_000);

  it('routes scanned pages through the configured OCR engine', async () => {
    const calls: number[] = [];
    const ocrEngine: PdfOcrEngine = {
      async recognize(input) {
        calls.push(input.page);
        return {
          text: `OCR content for page ${input.page}`,
          confidence: 92,
          blocks: [
            {
              text: `OCR content for page ${input.page}`,
              confidence: 92,
              bbox: { x: 0.1, y: 0.1, width: 0.8, height: 0.2 },
            },
          ],
        };
      },
    };
    const parser = new PdfDocumentParser({
      ocrEngine,
      nativeTextMinCharacters: 10_000,
    });
    const result = await parser.parse({
      filename: 'parser-sample.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(calls).toEqual([1, 2]);
    expect(result.stats).toMatchObject({ scannedPages: 2, ocrPages: 2 });
    expect(result.markdown).toContain('OCR content for page 1');
    expect(result.structure?.pages[0]?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ocr', confidence: 92, searchable: true }),
      ]),
    );
  }, 20_000);

  it('classifies native, scanned, and mixed pages', () => {
    expect(classifyPdfPage(120, 0)).toBe('native');
    expect(classifyPdfPage(0, 1)).toBe('scanned');
    expect(classifyPdfPage(120, 1)).toBe('mixed');
  });

  it('adds searchable visual descriptions for eligible PDF images', async () => {
    const visionEngine: PdfVisionEngine = {
      async analyze(input) {
        return {
          kind: 'chart',
          description: `Chart on page ${input.page} shows a rising blue series.`,
          searchable: true,
          confidence: 88,
        };
      },
    };
    const parser = new PdfDocumentParser({
      visionEngine,
      visionMinPixels: 1,
      visionRequiredForMixedPages: true,
    });
    const result = await parser.parse({
      filename: 'parser-sample.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.markdown).toContain('Visual analysis: Chart on page 1');
    expect(result.structure?.pages[0]?.visionAnalyzedImages).toBe(1);
    expect(result.structure?.pages[0]?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'figure',
          source: 'vision',
          searchable: true,
          confidence: 88,
        }),
      ]),
    );
    expect(result.structure?.quality.status).toBe('pass');
  });

  it('flags unprocessed scanned pages for review', async () => {
    const parser = new PdfDocumentParser({ nativeTextMinCharacters: 10_000 });
    const result = await parser.parse({
      filename: 'parser-sample.pdf',
      mimeType: 'application/pdf',
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.structure?.quality).toMatchObject({
      status: 'review',
      scannedPages: 2,
      unprocessedScannedPages: 2,
    });
  });

  it('renders a requested PDF page as PNG', async () => {
    const bytes = await renderPdfPagePng(new Uint8Array(await readFile(fixture)), 1, 800);

    expect(bytes.slice(0, 8)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });
});
