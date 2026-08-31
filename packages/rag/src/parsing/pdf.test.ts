import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PdfDocumentParser } from './pdf';

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
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors.map((anchor) => anchor.page)).toEqual([1, 2]);
    expect(result.markdown.slice(result.anchors[1]?.offsetStart)).toMatch(/^## Page 2/);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      anchor: { type: 'page', page: 1 },
    });
    expect(result.markdown).toContain('knowledge-asset://pdf-image-p1-001.png');
  }, 20_000);
});
