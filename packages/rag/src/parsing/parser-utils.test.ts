import { describe, expect, it } from 'vitest';
import { assetReference, toMarkdownTable } from './parser-utils';

describe('parser utilities', () => {
  it('creates internal asset references', () => {
    expect(assetReference('image 1.png')).toBe('knowledge-asset://image%201.png');
  });

  it('converts rectangular data to a padded Markdown table', () => {
    expect(toMarkdownTable([['Name', 'Value'], ['A|B', '1'], ['Only name']])).toBe(
      '| Name | Value |\n| --- | --- |\n| A\\|B | 1 |\n| Only name |  |',
    );
  });
});
