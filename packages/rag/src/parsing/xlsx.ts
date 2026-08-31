import ExcelJS from 'exceljs';
import { parseOffice } from 'officeparser';
import type { DocumentParser, ParseInput, ParseResult, SourceAnchor } from '../index';
import { cleanMarkdown, extensionOf } from './plain-text';
import { loadOfficePackage, readZipText } from './office-package';
import { ParserLimitError, toMarkdownTable, withTimeout } from './parser-utils';

const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_XLSX_SHEETS = 100;
const MAX_XLSX_ROWS_PER_SHEET = 50_000;
const MAX_XLSX_COLUMNS = 256;
const MAX_XLSX_CELLS = 500_000;
const MAX_WORKSHEET_XML_BYTES = 25 * 1024 * 1024;
const MAX_MARKDOWN_CHARACTERS = 5_000_000;
const PARSE_TIMEOUT_MS = 60_000;
const MAX_FORMULA_WARNINGS = 100;

type WorksheetSection = {
  markdown: string;
  sheet: string;
  rowStart?: number;
  rowEnd?: number;
};

export class XlsxDocumentParser implements DocumentParser {
  readonly name = 'exceljs-officeparser';
  readonly version = '1.0.0';

  supports(input: Pick<ParseInput, 'filename' | 'mimeType'>): boolean {
    const extension = extensionOf(input.filename);
    return extension ? extension === 'xlsx' : input.mimeType.toLowerCase() === XLSX_MIME_TYPE;
  }

  async parse(input: ParseInput): Promise<ParseResult> {
    if (!this.supports(input)) throw new Error('Unsupported XLSX format');
    if (input.bytes.byteLength === 0) throw new Error('XLSX file is empty');

    const normalizedBytes = await preflightAndNormalizeXlsx(input.bytes);
    try {
      return await this.parseWithExcelJs(normalizedBytes);
    } catch (error) {
      if (error instanceof ParserLimitError) throw error;
      return this.parseWithOfficeParser(normalizedBytes, error);
    }
  }

  private async parseWithExcelJs(bytes: Uint8Array): Promise<ParseResult> {
    const workbook = new ExcelJS.Workbook();
    await withTimeout(
      workbook.xlsx.load(Buffer.from(bytes) as unknown as ExcelJS.Buffer),
      PARSE_TIMEOUT_MS,
      'XLSX parsing timed out after 60 seconds',
    );
    if (workbook.worksheets.length > MAX_XLSX_SHEETS) {
      throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_SHEETS}-sheet limit`);
    }

    const warnings: string[] = [];
    const sections: WorksheetSection[] = [];
    let totalCells = 0;
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > MAX_XLSX_ROWS_PER_SHEET) {
        throw new ParserLimitError(
          `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_ROWS_PER_SHEET}-row limit`,
        );
      }
      if (sheet.columnCount > MAX_XLSX_COLUMNS) {
        throw new ParserLimitError(
          `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_COLUMNS}-column limit`,
        );
      }

      const rows: Array<{ number: number; cells: string[] }> = [];
      let maximumColumn = 0;
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        let lastPopulatedColumn = 0;
        row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
          if (cell.value != null) lastPopulatedColumn = Math.max(lastPopulatedColumn, columnNumber);
        });
        if (lastPopulatedColumn === 0) return;
        if (lastPopulatedColumn > MAX_XLSX_COLUMNS) {
          throw new ParserLimitError(
            `XLSX sheet "${sheet.name}" exceeds the ${MAX_XLSX_COLUMNS}-column limit`,
          );
        }
        totalCells += lastPopulatedColumn;
        if (totalCells > MAX_XLSX_CELLS) {
          throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_CELLS}-cell limit`);
        }
        maximumColumn = Math.max(maximumColumn, lastPopulatedColumn);
        rows.push({
          number: rowNumber,
          cells: Array.from({ length: lastPopulatedColumn }, (_, index) => {
            const cell = row.getCell(index + 1);
            if (cell.isMerged && cell.master.address !== cell.address) return '';
            return cellToString(cell.value, sheet.name, cell.address, warnings);
          }),
        });
      });

      const normalizedRows = rows.map(({ cells }) =>
        Array.from({ length: maximumColumn }, (_, index) => cells[index] ?? ''),
      );
      const table = toMarkdownTable(normalizedRows);
      const markdown = cleanMarkdown(`## Sheet: ${sheet.name}${table ? `\n\n${table}` : ''}`);
      sections.push({
        markdown,
        sheet: sheet.name,
        rowStart: rows[0]?.number,
        rowEnd: rows.at(-1)?.number,
      });
    }

    const { markdown, anchors } = joinSections(sections);
    if (!markdown) throw new Error('Parsed XLSX document is empty');
    assertMarkdownLimit(markdown, 'XLSX');
    return {
      markdown,
      anchors,
      assets: [],
      warnings,
      stats: { characters: markdown.length, sheets: workbook.worksheets.length },
    };
  }

  private async parseWithOfficeParser(
    bytes: Uint8Array,
    primaryError: unknown,
  ): Promise<ParseResult> {
    try {
      const ast = await withTimeout(
        parseOffice(bytes, { fileType: 'xlsx', extractAttachments: false }),
        PARSE_TIMEOUT_MS,
        'XLSX fallback parsing timed out after 60 seconds',
      );
      const converted = await withTimeout(
        ast.to('md'),
        PARSE_TIMEOUT_MS,
        'XLSX fallback Markdown conversion timed out after 60 seconds',
      );
      const markdown = cleanMarkdown(String(converted.value ?? ''));
      if (!markdown) throw new Error('officeparser returned empty Markdown');
      assertMarkdownLimit(markdown, 'XLSX');
      return {
        markdown,
        anchors: [{ type: 'document', offsetStart: 0, offsetEnd: markdown.length }],
        assets: [],
        warnings: [
          `ExcelJS parsing failed; used officeparser fallback: ${errorMessage(primaryError)}`,
        ],
        stats: { characters: markdown.length },
      };
    } catch (fallbackError) {
      throw new Error(
        `XLSX parsing failed (ExcelJS: ${errorMessage(primaryError)}; officeparser: ${errorMessage(fallbackError)})`,
      );
    }
  }
}

async function preflightAndNormalizeXlsx(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await loadOfficePackage(bytes, 'XLSX');
  const worksheets = Object.entries(zip.files).filter(
    ([path, file]) => !file.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(path),
  );
  if (worksheets.length === 0) throw new Error('XLSX package contains no worksheets');
  if (worksheets.length > MAX_XLSX_SHEETS) {
    throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_SHEETS}-sheet limit`);
  }

  let totalCells = 0;
  for (const [path, file] of worksheets) {
    const xml = await readZipText(file, 'XLSX', MAX_WORKSHEET_XML_BYTES);
    const dimensions = xml.match(
      /<(?:[A-Za-z_][\w.-]*:)?dimension\b[^>]*\bref="(?:[^:"]+:)?([A-Z]+)(\d+)"/i,
    );
    if (dimensions) {
      const column = columnNumber(dimensions[1] ?? '');
      const row = Number(dimensions[2] ?? 0);
      if (row > MAX_XLSX_ROWS_PER_SHEET) {
        throw new ParserLimitError(`${path} exceeds the ${MAX_XLSX_ROWS_PER_SHEET}-row limit`);
      }
      if (column > MAX_XLSX_COLUMNS) {
        throw new ParserLimitError(`${path} exceeds the ${MAX_XLSX_COLUMNS}-column limit`);
      }
    }
    const cells = xml.match(/<(?:[A-Za-z_][\w.-]*:)?c(?:\s|>)/g)?.length ?? 0;
    totalCells += cells;
    if (totalCells > MAX_XLSX_CELLS) {
      throw new ParserLimitError(`XLSX exceeds the ${MAX_XLSX_CELLS}-cell limit`);
    }
  }

  for (const [path, file] of Object.entries(zip.files)) {
    if (file.dir || !/^xl\/.*\.xml$/i.test(path)) continue;
    const xml = await readZipText(file, 'XLSX', 100 * 1024 * 1024);
    const normalized = normalizeSpreadsheetNamespace(xml);
    if (normalized !== xml) zip.file(path, normalized);
  }
  return withTimeout(
    zip.generateAsync({ type: 'uint8array' }),
    PARSE_TIMEOUT_MS,
    'XLSX package normalization timed out after 60 seconds',
  );
}

function normalizeSpreadsheetNamespace(xml: string): string {
  const namespace = xml.match(
    /xmlns:([A-Za-z_][\w.-]*)="http:\/\/schemas\.openxmlformats\.org\/spreadsheetml\/2006\/main"/,
  );
  const prefix = namespace?.[1];
  if (!prefix) return xml;
  const qualifiedTag = new RegExp(`(<\\/?)(?:${escapeRegExp(prefix)}):`, 'g');
  return xml
    .replace(qualifiedTag, '$1')
    .replace(namespace[0], 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cellToString(
  value: ExcelJS.CellValue,
  sheetName: string,
  address: string,
  warnings: string[],
): string {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (value instanceof Date) return value.toISOString();
  if ('error' in value) return value.error;
  if ('richText' in value) return value.richText.map((part) => part.text).join('');
  if ('hyperlink' in value) return `[${value.text}](${value.hyperlink})`;
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result != null) return cellToString(value.result, sheetName, address, warnings);
    if (warnings.length < MAX_FORMULA_WARNINGS) {
      warnings.push(`Formula ${sheetName}!${address} has no cached result`);
    }
    const formula = 'formula' in value ? value.formula : value.sharedFormula;
    return formula ? `=${formula}` : '';
  }
  return String(value);
}

function joinSections(sections: WorksheetSection[]): {
  markdown: string;
  anchors: SourceAnchor[];
} {
  const markdown = sections.map((section) => section.markdown).join('\n\n');
  const anchors: SourceAnchor[] = [];
  let offset = 0;
  for (const section of sections) {
    anchors.push({
      type: 'sheet',
      sheet: section.sheet,
      rowStart: section.rowStart,
      rowEnd: section.rowEnd,
      offsetStart: offset,
      offsetEnd: offset + section.markdown.length,
    });
    offset += section.markdown.length + 2;
  }
  return { markdown, anchors };
}

function columnNumber(column: string): number {
  return [...column.toUpperCase()].reduce(
    (value, character) => value * 26 + character.charCodeAt(0) - 64,
    0,
  );
}

function assertMarkdownLimit(markdown: string, format: string): void {
  if (markdown.length > MAX_MARKDOWN_CHARACTERS) {
    throw new ParserLimitError(`${format} Markdown exceeds ${MAX_MARKDOWN_CHARACTERS} characters`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
