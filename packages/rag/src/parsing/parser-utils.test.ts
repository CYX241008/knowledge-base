import { describe, expect, it } from 'vitest';
import { assetReference, imageDimensions, toMarkdownTable } from './parser-utils';

describe('parser utilities', () => {
  it('creates internal asset references', () => {
    expect(assetReference('image 1.png')).toBe('knowledge-asset://image%201.png');
  });

  it('converts rectangular data to a padded Markdown table', () => {
    expect(toMarkdownTable([['Name', 'Value'], ['A|B', '1'], ['Only name']])).toBe(
      '| Name | Value |\n| --- | --- |\n| A\\|B | 1 |\n| Only name |  |',
    );
  });

  it('reads dimensions from supported image headers', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    const view = new DataView(png.buffer);
    view.setUint32(16, 640);
    view.setUint32(20, 480);

    expect(imageDimensions(png, 'image/png')).toEqual({ width: 640, height: 480 });
  });
});
