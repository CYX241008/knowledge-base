import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
