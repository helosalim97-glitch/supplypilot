/*
 * Small RFC 4180 CSV reader for uploaded imports. Uploaded text is untrusted,
 * so the reader enforces row, column and cell limits and fails with the row
 * number of the first problem instead of guessing.
 *
 * - Cells are separated by "," or ";" (whichever appears more often in the
 *   header line, outside quotes; "," on a tie).
 * - Quoted cells may contain the delimiter, line breaks and "" for a quote.
 * - Records end with \r\n, \n or \r. Blank lines are skipped.
 * - A leading UTF-8 byte order mark is ignored.
 */

export type CsvDelimiter = ',' | ';';

export interface CsvLimits {
  /** Data rows, not counting the header. */
  maxRows: number;
  maxColumns: number;
  maxCellLength: number;
}

export interface CsvRecord {
  /** Position in the file counting the header as row 1, blank lines included. */
  rowNumber: number;
  cells: string[];
}

export interface ParsedCsv {
  delimiter: CsvDelimiter;
  /** Trimmed header names, unique ignoring case. */
  header: string[];
  records: CsvRecord[];
}

/** The file cannot be read as CSV. `row` is the row the problem was found on. */
export class CsvError extends Error {
  constructor(
    readonly row: number,
    reason: string,
  ) {
    super(`row ${row}: ${reason}`);
    this.name = 'CsvError';
  }
}

/** Picks the delimiter from the first line, ignoring quoted text. */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '\n' || ch === '\r') break;
    else if (ch === ',') commas++;
    else if (ch === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(input: string, limits: CsvLimits): ParsedCsv {
  const text = input.startsWith('﻿') ? input.slice(1) : input;
  const delimiter = detectDelimiter(text);
  const rows: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  let row = 1;

  const endCell = (): void => {
    if (cell.length > limits.maxCellLength) {
      throw new CsvError(row, `has a cell longer than ${limits.maxCellLength} characters`);
    }
    cells.push(cell);
    cell = '';
    closedQuote = false;
    if (cells.length > limits.maxColumns) {
      throw new CsvError(row, `has more than ${limits.maxColumns} columns`);
    }
  };

  const endRecord = (): void => {
    endCell();
    const blank = cells.length === 1 && cells[0].trim() === '';
    if (!blank) {
      if (rows.length > limits.maxRows) {
        throw new CsvError(row, `the file has more than ${limits.maxRows} data rows`);
      }
      rows.push({ rowNumber: row, cells });
    }
    cells = [];
    row++;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        closedQuote = true;
      } else {
        cell += ch;
      }
      i++;
      continue;
    }
    if (ch === delimiter) {
      endCell();
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else if (closedQuote) {
      throw new CsvError(row, 'has text after the closing quote of a cell');
    } else if (ch === '"') {
      if (cell.length > 0) throw new CsvError(row, 'has a quote inside an unquoted cell');
      quoted = true;
      i++;
    } else {
      cell += ch;
      i++;
    }
  }
  if (quoted) throw new CsvError(row, 'has a quoted cell that is never closed');
  if (cell.length > 0 || cells.length > 0 || closedQuote) endRecord();

  const [first, ...records] = rows;
  if (!first) throw new CsvError(1, 'the file is empty');
  const header = first.cells.map((name) => name.trim());
  const seen = new Set<string>();
  header.forEach((name, index) => {
    if (name === '') throw new CsvError(first.rowNumber, `header column ${index + 1} is empty`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new CsvError(first.rowNumber, `header "${name}" appears twice`);
    seen.add(key);
  });
  return { delimiter, header, records };
}
