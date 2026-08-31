import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PptxDocumentParser } from './pptx';

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
    expect(result.anchors.map((anchor) => anchor.slide)).toEqual([1, 2]);
    expect(result.markdown.slice(result.anchors[1]?.offsetStart)).toMatch(/^## Slide 2/);
    expect(result.warnings).toEqual([]);
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
});

function slideXml(title: string): string {
  return `<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}
