import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentProcessingMetric, OcrEngine, VisionEngine } from '../structured-document';
import { PptxDocumentParser, type PptxParserOptions } from './pptx';

const fixture = resolve(process.cwd(), 'test-fixtures/parser-sample.pptx');
const mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('PptxDocumentParser', () => {
  it('preserves slide titles, body text, tables, and slide anchors', async () => {
    const result = await new PptxDocumentParser().parse({
      filename: 'parser-sample.pptx',
      mimeType,
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.stats.slides).toBe(2);
    expect(result.markdown).toContain('## Slide 1');
    expect(result.markdown).toContain('### Quarterly Knowledge Review');
    expect(result.markdown).toContain('Two slides verify title, body, table, and source anchors.');
    expect(result.markdown).not.toContain('### Two slides verify');
    expect(result.markdown).toContain('## Slide 2');
    expect(result.markdown).toContain('### Structured content remains traceable');
    expect(result.markdown).toContain('| Stage | Owner | Status |');
    expect(result.markdown).toContain('| Parse | Worker | Ready |');
    expect(result.markdown).not.toMatch(/^2$/m);
    const slideAnchors = result.anchors.filter((anchor) => !anchor.elementId);
    expect(slideAnchors.map((anchor) => anchor.slide)).toEqual([1, 2]);
    expect(result.markdown.slice(slideAnchors[1]?.offsetStart)).toMatch(/^## Slide 2/);
    expect(result.warnings).toEqual([]);
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'pptx',
      units: [
        { id: 'slide-1', location: { type: 'slide', slide: 1 } },
        { id: 'slide-2', location: { type: 'slide', slide: 2 } },
      ],
    });
    expect(result.structure?.tables[0]).toMatchObject({
      location: { type: 'slide', slide: 2 },
    });
    expect(result.structure?.tables[0]?.rows).toEqual(
      expect.arrayContaining([
        ['Stage', 'Owner', 'Status'],
        ['Parse', 'Worker', 'Ready'],
      ]),
    );
    const positionedElements =
      result.structure?.units.flatMap((unit) => unit.elements).filter((element) => element.bbox) ??
      [];
    expect(positionedElements.length).toBeGreaterThan(0);
    expect(
      positionedElements.every(
        (element) =>
          element.bbox &&
          element.bbox.x >= 0 &&
          element.bbox.y >= 0 &&
          element.bbox.width <= 1 &&
          element.bbox.height <= 1,
      ),
    ).toBe(true);
  });

  it('uses presentation relationships instead of slide filenames for ordering', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId2"/><p:sldId id="2" r:id="rId1"/></p:sldIdLst></p:presentation>',
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
    );
    zip.file('ppt/slides/slide1.xml', slideXml('Filename One'));
    zip.file('ppt/slides/slide2.xml', slideXml('Relationship First'));
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    const result = await new PptxDocumentParser().parse({
      filename: 'ordered.pptx',
      mimeType,
      bytes,
    });

    expect(result.markdown.indexOf('Relationship First')).toBeLessThan(
      result.markdown.indexOf('Filename One'),
    );
  });

  it('rejects presentations beyond the slide limit', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    for (let slide = 1; slide <= 501; slide += 1) {
      zip.file(`ppt/slides/slide${slide}.xml`, '<p:sld/>');
    }
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(
      new PptxDocumentParser().parse({ filename: 'oversized.pptx', mimeType, bytes }),
    ).rejects.toThrow('500-slide limit');
  });

  it('extracts positioned images and enriches them with OCR and vision', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'ppt/presentation.xml',
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="rId1"/></p:sldIdLst><p:sldSz cx="1000" cy="1000"/></p:presentation>',
    );
    zip.file(
      'ppt/_rels/presentation.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    );
    zip.file(
      'ppt/slides/slide1.xml',
      [
        '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree>',
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>',
        '<p:spPr><a:xfrm><a:off x="100" y="50"/><a:ext cx="800" cy="100"/></a:xfrm></p:spPr>',
        '<p:txBody><a:p><a:r><a:t>Visual Report</a:t></a:r></a:p></p:txBody></p:sp>',
        '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Chart" descr="Revenue chart"/></p:nvPicPr>',
        '<p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill>',
        '<p:spPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="400" cy="300"/></a:xfrm></p:spPr></p:pic>',
        '</p:spTree></p:cSld></p:sld>',
      ].join(''),
    );
    zip.file(
      'ppt/slides/_rels/slide1.xml.rels',
      '<Relationships><Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
    );
    zip.file('ppt/media/image1.png', pngBytes(640, 480));
    const metrics: DocumentProcessingMetric[] = [];
    const ocrEngine: OcrEngine = {
      async recognize(input) {
        expect(input).toMatchObject({
          format: 'pptx',
          location: { type: 'slide', slide: 1 },
          width: 640,
          height: 480,
        });
        return {
          text: 'Revenue 42',
          confidence: 93,
          blocks: [
            {
              text: 'Revenue 42',
              confidence: 93,
              bbox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
            },
          ],
        };
      },
    };
    const visionEngine: VisionEngine = {
      async analyze(input) {
        expect(input.location).toEqual({ type: 'slide', slide: 1 });
        return {
          kind: 'chart',
          description: 'Revenue increases from left to right.',
          searchable: true,
          confidence: 89,
        };
      },
    };

    const result = await new PptxDocumentParser({
      ocrEngine,
      ocrMinPixels: 1,
      visionEngine,
      visionMinPixels: 1,
      onProcessingMetric(metric) {
        metrics.push(metric);
      },
    }).parse({
      filename: 'visual.pptx',
      mimeType,
      bytes: await zip.generateAsync({ type: 'uint8array' }),
    });

    expect(result.assets).toEqual([
      expect.objectContaining({
        filename: 'pptx-image-s1-001.png',
        anchor: { type: 'slide', slide: 1 },
      }),
    ]);
    expect(result.markdown).toContain('knowledge-asset://pptx-image-s1-001.png');
    expect(result.markdown).toContain('OCR text: Revenue 42');
    expect(result.markdown).toContain('Visual analysis: Revenue increases from left to right.');
    const elements = result.structure?.units[0]?.elements ?? [];
    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'figure',
          figureId: 's1-f1',
          bbox: { x: 0.1, y: 0.2, width: 0.4, height: 0.3 },
        }),
        expect.objectContaining({
          source: 'ocr',
          bbox: { x: 0.14, y: 0.26, width: 0.2, height: 0.03 },
        }),
        expect.objectContaining({ source: 'vision', confidence: 89 }),
      ]),
    );
    expect(metrics).toEqual([
      expect.objectContaining({
        operation: 'ocr',
        format: 'pptx',
        location: { type: 'slide', slide: 1 },
      }),
      expect.objectContaining({
        operation: 'vision',
        format: 'pptx',
        location: { type: 'slide', slide: 1 },
      }),
    ]);
  });

  it('returns a reviewable v2 structure from the officeparser fallback', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="p"/>');
    const officeParser = vi.fn(async () => ({
      to: async () => ({
        value: '# Recovered Presentation\n\nFallback slide content.',
      }),
    }));

    const result = await new PptxDocumentParser({
      officeParser: officeParser as unknown as PptxParserOptions['officeParser'],
    }).parse({
      filename: 'fallback.pptx',
      mimeType,
      bytes: await zip.generateAsync({ type: 'uint8array' }),
    });

    expect(officeParser).toHaveBeenCalledOnce();
    expect(result.warnings[0]).toContain('used officeparser fallback');
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'pptx',
      quality: { status: 'review' },
    });
    expect(result.structure?.units[0]?.elements[0]).toMatchObject({
      kind: 'heading',
      text: 'Recovered Presentation',
    });
  });
});

function slideXml(title: string): string {
  return `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
