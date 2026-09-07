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
      version: 2,
      format: 'pdf',
      quality: {
        status: 'pass',
        score: 100,
        reasons: [],
        metrics: {
          scannedPages: 0,
          unprocessedScannedPages: 0,
          lowConfidenceOcrPages: 0,
          emptySearchablePages: 0,
          unanalyzedVisuals: 0,
        },
      },
      tables: [
        {
          id: 'p1-t1',
          location: { type: 'page', page: 1 },
          rows: [
            ['Region', 'Revenue'],
            ['North America', '100000'],
            ['Europe', '90000'],
            ['Asia Pacific', '80000'],
          ],
          markdown: table.slice('### Table 1\n\n'.length),
        },
      ],
      units: [
        {
          id: 'page-1',
          location: { type: 'page', page: 1 },
          width: 600,
          height: 800,
          classification: 'native',
          textCharacters: 100,
          textCoverage: 0.1,
          imageCount: 0,
          ocrApplied: false,
          visionAnalyzedImages: 0,
          elements: [
            {
              id: 'p1-e1',
              kind: 'heading',
              location: { type: 'page', page: 1 },
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
              location: { type: 'page', page: 1 },
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
              location: { type: 'page', page: 1 },
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

  it('preserves slide and sheet locations in structured chunks', () => {
    const slideMarkdown = '## Slide 1\n\nArchitecture overview';
    const slideStructure: StructuredDocument = {
      version: 2,
      format: 'pptx',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [],
      units: [
        {
          id: 'slide-1',
          location: { type: 'slide', slide: 1 },
          elements: [
            {
              id: 's1-e1',
              kind: 'paragraph',
              location: { type: 'slide', slide: 1 },
              order: 1,
              text: 'Architecture overview',
              markdown: 'Architecture overview',
              offsetStart: slideMarkdown.indexOf('Architecture'),
              offsetEnd: slideMarkdown.length,
              searchable: true,
              source: 'native',
              sectionPath: ['Architecture'],
            },
          ],
        },
      ],
    };
    const sheetMarkdown = '## Sheet: Summary\n\n| Name | Value |\n| --- | --- |\n| Alpha | 1 |';
    const sheetStructure: StructuredDocument = {
      version: 2,
      format: 'xlsx',
      quality: { status: 'pass', score: 100, reasons: [], metrics: {} },
      tables: [],
      units: [
        {
          id: 'sheet-Summary',
          location: {
            type: 'sheet',
            sheet: 'Summary',
            rowStart: 1,
            rowEnd: 2,
            range: 'A1:B2',
          },
          elements: [
            {
              id: 'sheet-Summary-e1',
              kind: 'table',
              location: {
                type: 'sheet',
                sheet: 'Summary',
                rowStart: 1,
                rowEnd: 2,
                range: 'A1:B2',
              },
              order: 1,
              text: 'Name | Value\nAlpha | 1',
              markdown: sheetMarkdown,
              offsetStart: 0,
              offsetEnd: sheetMarkdown.length,
              searchable: true,
              source: 'native',
              sectionPath: ['Summary'],
              tableId: 'sheet-Summary-t1',
            },
          ],
        },
      ],
    };

    expect(
      chunkMarkdown(versionId, slideMarkdown, [], { structure: slideStructure })[0]?.anchor,
    ).toMatchObject({ type: 'slide', slide: 1 });
    expect(
      chunkMarkdown(versionId, sheetMarkdown, [], { structure: sheetStructure })[0]?.anchor,
    ).toMatchObject({
      type: 'sheet',
      sheet: 'Summary',
      rowStart: 1,
      rowEnd: 2,
      range: 'A1:B2',
    });
  });
});
