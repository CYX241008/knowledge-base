import { describe, expect, it } from 'vitest';
import { PlainTextDocumentParser, cleanMarkdown } from './plain-text';

describe('PlainTextDocumentParser', () => {
  it('normalizes markdown and creates heading anchors', async () => {
    const parser = new PlainTextDocumentParser();
    const result = await parser.parse({
      filename: 'guide.md',
      mimeType: 'text/markdown',
      bytes: new TextEncoder().encode('# Guide\r\n\r\n\r\n\r\nBody\n\n## Next\nText'),
    });

    expect(result.markdown).toBe('# Guide\n\n\nBody\n\n## Next\nText');
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0]).toMatchObject({ type: 'heading', heading: 'Guide', offsetStart: 0 });
    expect(result.anchors[1]).toMatchObject({ type: 'heading', heading: 'Next' });
    expect(result.structure).toMatchObject({
      version: 2,
      format: 'markdown',
      units: [
        {
          location: { type: 'section', heading: 'Guide' },
          elements: [
            { kind: 'heading', sectionPath: ['Guide'] },
            { kind: 'paragraph', sectionPath: ['Guide'] },
          ],
        },
        {
          location: { type: 'section', heading: 'Next' },
          elements: [
            { kind: 'heading', sectionPath: ['Guide', 'Next'] },
            { kind: 'paragraph', sectionPath: ['Guide', 'Next'] },
          ],
        },
      ],
    });
  });

  it('preserves GFM tables and fenced code as semantic elements', async () => {
    const parser = new PlainTextDocumentParser();
    const markdown = [
      '# Data',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| Alpha | 1 |',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n');
    const result = await parser.parse({
      filename: 'data.md',
      mimeType: 'text/markdown',
      bytes: new TextEncoder().encode(markdown),
    });

    expect(result.structure?.tables[0]).toMatchObject({
      rows: [
        ['Name', 'Value'],
        ['Alpha', '1'],
      ],
      location: { type: 'section', heading: 'Data' },
    });
    expect(result.structure?.units[0]?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'table', tableId: 'markdown-t1' }),
        expect.objectContaining({ kind: 'code', text: 'const value = 1;' }),
      ]),
    );
  });

  it('creates paragraph elements for plain text', async () => {
    const parser = new PlainTextDocumentParser();
    const result = await parser.parse({
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('First paragraph.\n\nSecond paragraph.'),
    });

    expect(result.structure).toMatchObject({
      version: 2,
      format: 'text',
      units: [
        {
          location: { type: 'document' },
          elements: [
            { kind: 'paragraph', text: 'First paragraph.' },
            { kind: 'paragraph', text: 'Second paragraph.' },
          ],
        },
      ],
    });
  });

  it('rejects empty documents', async () => {
    const parser = new PlainTextDocumentParser();
    await expect(
      parser.parse({ filename: 'empty.txt', mimeType: 'text/plain', bytes: new Uint8Array() }),
    ).rejects.toThrow('Parsed document is empty');
  });
});

describe('cleanMarkdown', () => {
  it('normalizes line endings and excessive blank lines', () => {
    expect(cleanMarkdown(' a\r\n\r\n\r\n\r\n b ')).toBe('a\n\n\n b');
  });
});
