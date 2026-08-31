import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { XlsxDocumentParser } from './xlsx';

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
    });
    expect(result.anchors[1]).toMatchObject({
      type: 'sheet',
      sheet: 'Risks',
      rowStart: 1,
      rowEnd: 4,
    });
    expect(result.markdown.slice(result.anchors[1]?.offsetStart)).toMatch(/^## Sheet: Risks/);
    expect(result.warnings).toEqual([]);
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
});
