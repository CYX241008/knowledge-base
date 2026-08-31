import { describe, expect, it } from 'vitest';
import { chunkMarkdown } from './markdown';

const versionId = '11111111-1111-4111-8111-111111111111';

describe('chunkMarkdown', () => {
  it('never crosses page boundaries and keeps heading context', () => {
    const pageOne = '# Overview\n\n' + 'alpha '.repeat(45);
    const pageTwo = '# Details\n\n' + 'beta '.repeat(45);
    const markdown = pageOne + pageTwo;
    const chunks = chunkMarkdown(
      versionId,
      markdown,
      [
        { type: 'page', page: 1, offsetStart: 0, offsetEnd: pageOne.length },
        { type: 'heading', heading: 'Overview', offsetStart: 0, offsetEnd: pageOne.length },
        {
          type: 'page',
          page: 2,
          offsetStart: pageOne.length,
          offsetEnd: markdown.length,
        },
        {
          type: 'heading',
          heading: 'Details',
          offsetStart: pageOne.length,
          offsetEnd: markdown.length,
        },
      ],
      { maxCharacters: 140, overlapCharacters: 20 },
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(
      chunks
        .filter((chunk) => chunk.anchor.page === 1)
        .every((chunk) => !chunk.content.includes('beta')),
    ).toBe(true);
    expect(
      chunks
        .filter((chunk) => chunk.anchor.page === 2)
        .every((chunk) => !chunk.content.includes('alpha')),
    ).toBe(true);
    expect(chunks[0]?.anchor.heading).toBe('Overview');
    expect(chunks.at(-1)?.anchor.heading).toBe('Details');
  });

  it('uses stable ids and exact source offsets', () => {
    const markdown = '# Sheet\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |';
    const anchors = [
      {
        type: 'sheet' as const,
        sheet: 'Summary',
        rowStart: 1,
        rowEnd: 2,
        offsetStart: 0,
        offsetEnd: markdown.length,
      },
    ];
    const first = chunkMarkdown(versionId, markdown, anchors);
    const second = chunkMarkdown(versionId, markdown, anchors);

    expect(first).toEqual(second);
    expect(first[0]?.anchor).toMatchObject({ type: 'sheet', sheet: 'Summary', rowStart: 1 });
    expect(markdown.slice(first[0]?.offsetStart, first[0]?.offsetEnd)).toBe(first[0]?.content);
  });
});
