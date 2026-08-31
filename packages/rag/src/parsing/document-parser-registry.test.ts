import { describe, expect, it } from 'vitest';
import { DocumentParserRegistry } from './document-parser-registry';

describe('DocumentParserRegistry', () => {
  it('returns parser metadata with the parse result', async () => {
    const result = await new DocumentParserRegistry().parse({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      bytes: new TextEncoder().encode('# Notes'),
    });

    expect(result).toMatchObject({ parserName: 'plain-text', parserVersion: '1.0.0' });
  });

  it('rejects unsupported formats', async () => {
    await expect(
      new DocumentParserRegistry().parse({
        filename: 'archive.zip',
        mimeType: 'application/zip',
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow('Unsupported document format: zip');
  });

  it('supports modern spreadsheet and presentation formats', () => {
    const registry = new DocumentParserRegistry();
    expect(
      registry.supports({ filename: 'report.xlsx', mimeType: 'application/octet-stream' }),
    ).toBe(true);
    expect(
      registry.supports({ filename: 'briefing.pptx', mimeType: 'application/octet-stream' }),
    ).toBe(true);
  });
});
