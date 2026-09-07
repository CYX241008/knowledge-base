import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { DocumentProcessingMetric, OcrEngine, VisionEngine } from '../structured-document';
import { XlsxDocumentParser, type XlsxParserOptions } from './xlsx';

const fixture = resolve(process.cwd(), 'test-fixtures/parser-sample.xlsx');
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('XlsxDocumentParser', () => {
  it('preserves sheets, formula results, merged-cell policy, and row anchors', async () => {
    const result = await new XlsxDocumentParser().parse({
      filename: 'parser-sample.xlsx',
      mimeType,
      bytes: new Uint8Array(await readFile(fixture)),
    });

    expect(result.stats.sheets).toBe(2);
    expect(result.markdown).toContain('## Sheet: Operations');
    expect(result.markdown).toContain('| Team | Queued | Ready | Total |');
    expect(result.markdown).toContain('| Alpha | 12 | 18 | 30 |');
    expect(result.markdown).toContain('| Merged review note |  | Status | Reviewed |');
    expect(result.markdown).toContain('## Sheet: Risks');
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0]).toMatchObject({
      type: 'sheet',
      sheet: 'Operations',
      rowStart: 1,
      rowEnd: 5,
      range: 'A1:D5',
    });
    expect(result.anchors[1]).toMatchObject({
      type: 'sheet',
      sheet: 'Risks',
      rowStart: 1,
      rowEnd: 4,
      range: 'A1:C4',
    });
    expect(result.markdown.slice(result.anchors[1]?.offsetStart)).toMatch(/^## Sheet: Risks/);
    expect(result.warnings).toEqual([]);
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'xlsx',
      units: [
        {
          id: 'sheet-1-region-1',
          location: {
            type: 'sheet',
            sheet: 'Operations',
            rowStart: 1,
            rowEnd: 5,
            range: 'A1:D5',
          },
        },
        {
          id: 'sheet-2-region-1',
          location: {
            type: 'sheet',
            sheet: 'Risks',
            rowStart: 1,
            rowEnd: 4,
            range: 'A1:C4',
          },
        },
      ],
    });
    expect(result.structure?.tables[0]).toMatchObject({
      location: {
        type: 'sheet',
        sheet: 'Operations',
        rowStart: 1,
        rowEnd: 5,
        range: 'A1:D5',
      },
      rows: expect.arrayContaining([
        ['Team', 'Queued', 'Ready', 'Total'],
        ['Alpha', '12', '18', '30'],
      ]),
    });
  });

  it('rejects worksheets beyond the row limit before parsing cell data', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><dimension ref="A1:A50001"/><sheetData/></worksheet>',
    );
    const bytes = await zip.generateAsync({ type: 'uint8array' });

    await expect(
      new XlsxDocumentParser().parse({ filename: 'oversized.xlsx', mimeType, bytes }),
    ).rejects.toThrow('50000-row limit');
  });

  it('separates independent data regions within one sheet', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Summary');
    sheet.addRows([
      ['Team', 'Count', null, 'Risk', 'Owner'],
      ['Alpha', 3, null, 'Latency', 'Ops'],
      [null, null, null, null, null],
      ['Month', 'Revenue'],
      ['Jan', 100],
    ]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

    const result = await new XlsxDocumentParser().parse({
      filename: 'regions.xlsx',
      mimeType,
      bytes,
    });

    expect(result.anchors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheet: 'Summary', range: 'A1:B2' }),
        expect.objectContaining({ sheet: 'Summary', range: 'D1:E2' }),
        expect.objectContaining({ sheet: 'Summary', range: 'A4:B5' }),
      ]),
    );
    expect(result.structure?.units.map((unit) => unit.location)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'sheet', range: 'A1:B2' }),
        expect.objectContaining({ type: 'sheet', range: 'D1:E2' }),
        expect.objectContaining({ type: 'sheet', range: 'A4:B5' }),
      ]),
    );
  });

  it('extracts worksheet images and routes them through OCR and vision', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dashboard');
    sheet.addRows([
      ['Metric', 'Value'],
      ['Revenue', 42],
    ]);
    const imageId = workbook.addImage({
      base64: `data:image/png;base64,${Buffer.from(pngBytes(640, 480)).toString('base64')}`,
      extension: 'png',
    });
    sheet.addImage(imageId, 'D2:F8');
    const metrics: DocumentProcessingMetric[] = [];
    const ocrEngine: OcrEngine = {
      async recognize(input) {
        expect(input).toMatchObject({
          format: 'xlsx',
          location: { type: 'sheet', sheet: 'Dashboard', range: 'D2:F8' },
        });
        return { text: 'Revenue 42', confidence: 94, blocks: [] };
      },
    };
    const visionEngine: VisionEngine = {
      async analyze(input) {
        expect(input.location).toEqual({
          type: 'sheet',
          sheet: 'Dashboard',
          rowStart: 2,
          rowEnd: 8,
          range: 'D2:F8',
        });
        return {
          kind: 'chart',
          description: 'Revenue is 42.',
          searchable: true,
          confidence: 90,
        };
      },
    };
    const result = await new XlsxDocumentParser({
      ocrEngine,
      ocrMinPixels: 1,
      visionEngine,
      visionMinPixels: 1,
      onProcessingMetric(metric) {
        metrics.push(metric);
      },
    }).parse({
      filename: 'dashboard.xlsx',
      mimeType,
      bytes: new Uint8Array(await workbook.xlsx.writeBuffer()),
    });

    expect(result.assets).toEqual([
      expect.objectContaining({
        filename: 'xlsx-image-s1-001.png',
        anchor: expect.objectContaining({
          type: 'sheet',
          sheet: 'Dashboard',
          range: 'D2:F8',
        }),
      }),
    ]);
    expect(result.markdown).toContain('OCR text: Revenue 42');
    expect(result.markdown).toContain('Visual analysis: Revenue is 42.');
    expect(
      result.structure?.units
        .flatMap((unit) => unit.elements)
        .filter((element) => element.source === 'ocr' || element.source === 'vision'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'ocr', confidence: 94 }),
        expect.objectContaining({ source: 'vision', confidence: 90 }),
      ]),
    );
    expect(metrics).toHaveLength(2);
  });

  it('extracts cached chart data and preserves the drawing range', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Charts');
    sheet.addRows([
      ['Month', 'Revenue'],
      ['Jan', 100],
      ['Feb', 120],
    ]);
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
    const contentTypes = await zip.file('[Content_Types].xml')?.async('string');
    if (!contentTypes) throw new Error('Generated content types are missing');
    zip.file(
      '[Content_Types].xml',
      contentTypes.replace(
        '</Types>',
        '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>',
      ),
    );
    const sheetPath = 'xl/worksheets/sheet1.xml';
    const sheetXml = await zip.file(sheetPath)?.async('string');
    if (!sheetXml) throw new Error('Generated worksheet is missing');
    const withRelationshipNamespace = sheetXml.includes('xmlns:r=')
      ? sheetXml
      : sheetXml.replace(
          '<worksheet ',
          '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
        );
    zip.file(
      sheetPath,
      withRelationshipNamespace.replace('</worksheet>', '<drawing r:id="rIdDrawing"/></worksheet>'),
    );
    zip.file(
      'xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>',
    );
    zip.file(
      'xl/drawings/drawing1.xml',
      [
        '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
        '<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:row>1</xdr:row></xdr:from><xdr:to><xdr:col>7</xdr:col><xdr:row>12</xdr:row></xdr:to>',
        '<xdr:graphicFrame><a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame>',
        '<xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>',
      ].join(''),
    );
    zip.file(
      'xl/drawings/_rels/drawing1.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdChart" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>',
    );
    zip.file(
      'xl/charts/chart1.xml',
      [
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>',
        '<c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue Trend</a:t></a:r></a:p></c:rich></c:tx></c:title>',
        '<c:plotArea><c:barChart><c:ser>',
        '<c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Revenue</c:v></c:pt></c:strCache></c:strRef></c:tx>',
        '<c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:strCache></c:strRef></c:cat>',
        '<c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>100</c:v></c:pt><c:pt idx="1"><c:v>120</c:v></c:pt></c:numCache></c:numRef></c:val>',
        '</c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>',
      ].join(''),
    );

    const result = await new XlsxDocumentParser().parse({
      filename: 'chart.xlsx',
      mimeType,
      bytes: await zip.generateAsync({ type: 'uint8array' }),
    });

    expect(result.warnings).toEqual([]);
    expect(result.markdown).toContain('### Chart: Revenue Trend (D2:H13)');
    expect(result.markdown).toContain('Jan | 100');
    expect(result.structure?.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({
            type: 'sheet',
            sheet: 'Charts',
            range: 'D2:H13',
          }),
        }),
      ]),
    );
    expect(
      result.structure?.units
        .flatMap((unit) => unit.elements)
        .find((element) => element.figureId?.includes('chart')),
    ).toMatchObject({
      kind: 'figure',
      source: 'derived',
    });
  });

  it('returns a reviewable v2 structure from the officeparser fallback', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<worksheet><dimension ref="A1:B2"/><sheetData/></worksheet>',
    );
    const officeParser = vi.fn(async () => ({
      to: async () => ({
        value: '# Recovered Workbook\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |',
      }),
    }));

    const result = await new XlsxDocumentParser({
      officeParser: officeParser as unknown as XlsxParserOptions['officeParser'],
    }).parse({
      filename: 'fallback.xlsx',
      mimeType,
      bytes: await zip.generateAsync({ type: 'uint8array' }),
    });

    expect(officeParser).toHaveBeenCalledOnce();
    expect(result.warnings[0]).toContain('used officeparser fallback');
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'xlsx',
      quality: { status: 'review' },
    });
    expect(result.structure?.tables[0]?.rows).toEqual([
      ['Name', 'Value'],
      ['Alpha', '1'],
    ]);
  });
});

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}
