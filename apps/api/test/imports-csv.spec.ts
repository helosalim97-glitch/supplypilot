import { normalizeHeader, resolveMapping } from '../src/imports/column-mapping';
import { CsvError, detectDelimiter, parseCsv, type CsvLimits } from '../src/imports/csv';
import { codesInFile, previewRows, type CatalogCodes } from '../src/imports/import-preview';
import type { ColumnMapping, ImportableType } from '../src/imports/imports.models';

const LIMITS: CsvLimits = { maxRows: 100, maxColumns: 10, maxCellLength: 50 };
const SKU = '9a1b2c3d-4e5f-4a6b-8c7d-000000000001';
const WAREHOUSE = '7c2d3e4f-5a6b-4c7d-8e9f-000000000001';

function csvError(text: string, limits: CsvLimits = LIMITS): string {
  try {
    parseCsv(text, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(CsvError);
    return (error as Error).message;
  }
  throw new Error('expected a CsvError');
}

describe('parseCsv', () => {
  it('reads a header and records with row numbers', () => {
    const parsed = parseCsv('sku,warehouse,qty\nSKU-001,MAIN,5\nSKU-002,MAIN,7\n', LIMITS);
    expect(parsed).toEqual({
      delimiter: ',',
      header: ['sku', 'warehouse', 'qty'],
      records: [
        { rowNumber: 2, cells: ['SKU-001', 'MAIN', '5'] },
        { rowNumber: 3, cells: ['SKU-002', 'MAIN', '7'] },
      ],
    });
  });

  it('handles quotes, escaped quotes, delimiters and line breaks inside cells', () => {
    const parsed = parseCsv('sku,reason\n"SKU-001","Damaged, ""wet"" box\nsecond line"\n', LIMITS);
    expect(parsed.records).toEqual([
      { rowNumber: 2, cells: ['SKU-001', 'Damaged, "wet" box\nsecond line'] },
    ]);
  });

  it('accepts CRLF and CR line endings, a byte order mark and no final newline', () => {
    const parsed = parseCsv('﻿sku,qty\r\nA,1\rB,2', LIMITS);
    expect(parsed.header).toEqual(['sku', 'qty']);
    expect(parsed.records.map((r) => r.cells)).toEqual([
      ['A', '1'],
      ['B', '2'],
    ]);
  });

  it('skips blank lines but keeps counting them in row numbers', () => {
    const parsed = parseCsv('sku,qty\n\nA,1\n   \nB,2\n', LIMITS);
    expect(parsed.records.map((r) => r.rowNumber)).toEqual([3, 5]);
  });

  it('detects semicolon-separated files from the header line', () => {
    expect(detectDelimiter('sku;qty;reason\nA;1;"x,y"')).toBe(';');
    expect(detectDelimiter('"a;b",c\n')).toBe(',');
    const parsed = parseCsv('sku;qty\nA;"1,5"\n', LIMITS);
    expect(parsed.delimiter).toBe(';');
    expect(parsed.records[0].cells).toEqual(['A', '1,5']);
  });

  it('trims header names and rejects empty or repeated ones', () => {
    expect(parseCsv(' sku , qty \nA,1', LIMITS).header).toEqual(['sku', 'qty']);
    expect(csvError('sku,,qty\nA,1,2')).toBe('row 1: header column 2 is empty');
    expect(csvError('SKU,qty,sku\nA,1,B')).toBe('row 1: header "sku" appears twice');
  });

  it('reports malformed quoting with the row number', () => {
    expect(csvError('sku,qty\nA"B,1\n')).toBe('row 2: has a quote inside an unquoted cell');
    expect(csvError('sku,qty\n"A"B,1\n')).toBe('row 2: has text after the closing quote of a cell');
    expect(csvError('sku,qty\nA,1\n"B,2\n')).toBe('row 3: has a quoted cell that is never closed');
  });

  it('rejects empty files', () => {
    expect(csvError('')).toBe('row 1: the file is empty');
    expect(csvError('\n\n')).toBe('row 1: the file is empty');
  });

  it('enforces row, column and cell limits', () => {
    const limits = { maxRows: 2, maxColumns: 3, maxCellLength: 5 };
    expect(parseCsv('a\n1\n2\n', limits).records).toHaveLength(2);
    expect(csvError('a\n1\n2\n3\n', limits)).toBe('row 4: the file has more than 2 data rows');
    expect(csvError('a,b,c,d\n', limits)).toBe('row 1: has more than 3 columns');
    expect(csvError('a\n123456\n', limits)).toBe('row 2: has a cell longer than 5 characters');
  });
});

describe('resolveMapping', () => {
  it('matches common header names automatically', () => {
    const header = ['Item Code', 'Location', 'Qty', 'Movement Type', 'Notes', 'PO Number', 'Date'];
    expect(resolveMapping(header, {})).toEqual({
      errors: [],
      mapping: {
        skuCode: 'Item Code',
        warehouseCode: 'Location',
        type: 'Movement Type',
        quantity: 'Qty',
        reason: 'Notes',
        reference: 'PO Number',
        occurredAt: 'Date',
      },
    });
    expect(normalizeHeader('SKU_code ')).toBe('skucode');
  });

  it('lets explicit choices override or switch off automatic matching', () => {
    const header = ['sku', 'warehouse', 'qty', 'notes'];
    const { mapping, errors } = resolveMapping(header, { reference: 'NOTES', reason: null });
    expect(errors).toEqual([]);
    expect(mapping.reference).toBe('notes');
    expect(mapping.reason).toBeNull();
  });

  it('requires SKU, warehouse and quantity columns', () => {
    const { errors } = resolveMapping(['sku', 'count'], { quantity: null });
    expect(errors.map((e) => e.field)).toEqual(['mapping.warehouseCode', 'mapping.quantity']);
  });

  it('rejects unknown columns and a column mapped twice', () => {
    const { errors } = resolveMapping(['sku', 'warehouse', 'qty'], {
      skuCode: 'Product',
      warehouseCode: 'qty',
      quantity: 'qty',
    });
    expect(errors).toEqual([
      { field: 'mapping.skuCode', message: 'column "Product" is not in the file' },
      { field: 'mapping.quantity', message: 'column "qty" is already mapped to warehouseCode' },
    ]);
  });
});

describe('previewRows', () => {
  const now = new Date('2026-11-19T10:00:00Z');
  const catalog: CatalogCodes = {
    skus: new Map([['sku-001', SKU]]),
    warehouses: new Map([['main', WAREHOUSE]]),
  };
  const header = ['sku', 'warehouse', 'type', 'qty', 'reason', 'reference', 'date'];
  const mapping = resolveMapping(header, {}).mapping;

  const preview = (
    cells: string[],
    options: { mapping?: ColumnMapping; header?: string[]; defaultType?: ImportableType } = {},
  ) =>
    previewRows(
      options.header ?? header,
      options.mapping ?? mapping,
      options.defaultType ?? null,
      catalog,
      [{ rowNumber: 2, cells }],
      now,
    )[0];
  const fieldsOf = (cells: string[]) => preview(cells).errors.map((e) => e.field);

  it('turns a valid row into a movement with resolved ids', () => {
    const row = preview(['SKU-001', ' main ', 'Issue', '3', '', 'SO-1', '2026-11-18']);
    expect(row).toEqual({
      rowNumber: 2,
      status: 'valid',
      cells: ['SKU-001', ' main ', 'Issue', '3', '', 'SO-1', '2026-11-18'],
      values: {
        skuCode: 'SKU-001',
        warehouseCode: 'main',
        type: 'Issue',
        quantity: '3',
        reason: '',
        reference: 'SO-1',
        occurredAt: '2026-11-18',
      },
      movement: {
        skuId: SKU,
        warehouseId: WAREHOUSE,
        type: 'issue',
        quantityDelta: -3,
        reason: null,
        reference: 'SO-1',
        occurredAt: '2026-11-18T00:00:00.000Z',
      },
      errors: [],
    });
  });

  it('accepts signed adjustments with a reason', () => {
    const row = preview(['SKU-001', 'MAIN', 'adjustment', '-2', 'cycle count', '', '']);
    expect(row.movement).toMatchObject({ type: 'adjustment', quantityDelta: -2, reason: 'cycle count' });
  });

  it.each([
    [['SKU-999', 'MAIN', 'receipt', '5', '', '', ''], ['skuCode']],
    [['SKU-001', 'EAST', 'receipt', '5', '', '', ''], ['warehouseCode']],
    [['', '', 'receipt', '5', '', '', ''], ['skuCode', 'warehouseCode']],
    [['SKU-001', 'MAIN', 'receipt', '0', '', '', ''], ['quantity']],
    [['SKU-001', 'MAIN', 'receipt', '1.5', '', '', ''], ['quantity']],
    [['SKU-001', 'MAIN', 'issue', '-4', '', '', ''], ['quantity']],
    [['SKU-001', 'MAIN', 'correction', '1', '', '', ''], ['type']],
    [['SKU-001', 'MAIN', 'adjustment', '4', '', '', ''], ['reason']],
    [['SKU-001', 'MAIN', 'receipt', '5', '', '', '2026-11-25'], ['occurredAt']],
    [['SKU-001', 'MAIN', 'receipt', '5', '', '', '19/11/2026'], ['occurredAt']],
  ])('reports %j as invalid on %j', (cells, fields) => {
    const row = preview(cells);
    expect(row.status).toBe('invalid');
    expect(row.movement).toBeNull();
    expect(row.errors.map((e) => e.field)).toEqual(fields);
  });

  it('flags rows whose cell count differs from the header', () => {
    expect(fieldsOf(['SKU-001', 'MAIN', 'receipt', '5'])).toEqual(['row']);
    expect(preview(['SKU-001', 'MAIN', 'receipt', '5']).errors[0].message).toBe(
      'has 4 cells but the header has 7',
    );
  });

  it('uses defaultType when there is no type column or the cell is empty', () => {
    const noType = ['sku', 'warehouse', 'qty'];
    const options = { header: noType, mapping: resolveMapping(noType, {}).mapping };
    expect(preview(['SKU-001', 'MAIN', '5'], { ...options, defaultType: 'receipt' }).movement)
      .toMatchObject({ type: 'receipt', quantityDelta: 5 });
    expect(preview(['SKU-001', 'MAIN', '5'], options).errors).toEqual([
      { field: 'type', message: 'is empty and no defaultType was given' },
    ]);
    expect(preview(['SKU-001', 'MAIN', '', '2', '', '', ''], { defaultType: 'issue' }).movement)
      .toMatchObject({ type: 'issue', quantityDelta: -2 });
  });

  it('collects distinct codes for a single catalog lookup', () => {
    const records = [
      { rowNumber: 2, cells: ['SKU-001', 'MAIN', 'receipt', '1', '', '', ''] },
      { rowNumber: 3, cells: ['sku-001', 'East', 'receipt', '1', '', '', ''] },
      { rowNumber: 4, cells: ['', '', 'receipt', '1', '', '', ''] },
    ];
    expect(codesInFile(header, mapping, records)).toEqual({
      skuCodes: ['sku-001'],
      warehouseCodes: ['main', 'east'],
    });
  });
});
