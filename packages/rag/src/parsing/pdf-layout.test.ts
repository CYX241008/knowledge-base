import { describe, expect, it } from 'vitest';
import { createNativePageElements, markRepeatedMargins, type PdfLayoutPage } from './pdf-layout';

describe('PDF layout normalization', () => {
  it('marks repeated headers and footers as non-searchable elements', () => {
    const pages: PdfLayoutPage[] = [1, 2, 3].map((page) => ({
      page,
      width: 600,
      height: 800,
      textCharacters: 80,
      textCoverage: 0.1,
      lines: [
        {
          text: 'Quarterly Operations Report',
          x: 40,
          top: 20,
          width: 220,
          height: 12,
          fontSize: 12,
          column: 0,
        },
        {
          text: `Page ${page} of 3`,
          x: 270,
          top: 770,
          width: 60,
          height: 10,
          fontSize: 10,
          column: 0,
        },
        {
          text: `Body content ${page}`,
          x: 40,
          top: 120,
          width: 180,
          height: 11,
          fontSize: 11,
          column: 0,
        },
      ],
    }));

    markRepeatedMargins(pages, 0.6);
    const elements = createNativePageElements(pages[0]!, []);

    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'header', searchable: false }),
        expect.objectContaining({ kind: 'footer', searchable: false }),
        expect.objectContaining({
          kind: 'paragraph',
          searchable: true,
          text: 'Body content 1',
        }),
      ]),
    );
  });
});
