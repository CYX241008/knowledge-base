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
