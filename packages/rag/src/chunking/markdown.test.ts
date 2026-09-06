import { describe, expect, it } from 'vitest';
import type { StructuredDocument } from '../structured-document';
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

  it('keeps semantic elements together and repeats headers when splitting long tables', () => {
    const heading = '### Financial results';
    const paragraph = 'Revenue increased during the reporting period.';
    const table =
      '### Table 1\n\n| Region | Revenue |\n| --- | --- |\n| North America | 100000 |\n| Europe | 90000 |\n| Asia Pacific | 80000 |';
    const markdown = `## Page 1\n\n${heading}\n\n${paragraph}\n\n${table}`;
    const headingStart = markdown.indexOf(heading);
    const paragraphStart = markdown.indexOf(paragraph);
    const tableStart = markdown.indexOf(table);
    const structure: StructuredDocument = {
      version: 1,
      format: 'pdf',
      tables: [
        {
          id: 'p1-t1',
          page: 1,
          rows: [
            ['Region', 'Revenue'],
            ['North America', '100000'],
            ['Europe', '90000'],
            ['Asia Pacific', '80000'],
          ],
          markdown: table.slice('### Table 1\n\n'.length),
        },
      ],
      pages: [
        {
          page: 1,
          width: 600,
          height: 800,
          classification: 'native',
          textCharacters: 100,
          textCoverage: 0.1,
          imageCount: 0,
          ocrApplied: false,
          elements: [
            {
              id: 'p1-e1',
              kind: 'heading',
              page: 1,
              order: 1,
              text: 'Financial results',
              markdown: heading,
              offsetStart: headingStart,
              offsetEnd: headingStart + heading.length,
              searchable: true,
              source: 'native',
              sectionPath: ['Financial results'],
            },
            {
              id: 'p1-e2',
              kind: 'paragraph',
              page: 1,
              order: 2,
              text: paragraph,
              markdown: paragraph,
              offsetStart: paragraphStart,
              offsetEnd: paragraphStart + paragraph.length,
              searchable: true,
              source: 'native',
              sectionPath: ['Financial results'],
            },
            {
              id: 'p1-t1',
              kind: 'table',
              page: 1,
              order: 3,
              text: 'Region | Revenue',
              markdown: table,
              offsetStart: tableStart,
              offsetEnd: tableStart + table.length,
              searchable: true,
              source: 'derived',
              sectionPath: ['Financial results'],
              tableId: 'p1-t1',
            },
          ],
        },
      ],
    };

    const chunks = chunkMarkdown(versionId, markdown, [], {
      maxCharacters: 100,
      overlapCharacters: 10,
      structure,
    });
    const tableChunks = chunks.filter((chunk) => chunk.anchor.tableId === 'p1-t1');

    expect(chunks[0]?.content).toContain('Financial results');
    expect(chunks[0]?.content).toContain('Revenue increased');
    expect(tableChunks.length).toBeGreaterThan(1);
    expect(tableChunks.every((chunk) => chunk.content.includes('| Region | Revenue |'))).toBe(true);
  });
});
