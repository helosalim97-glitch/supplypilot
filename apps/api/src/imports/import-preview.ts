import type { FieldError } from '../http/api-error';
import { optionalText, parseOccurredAt, quantityDelta } from '../inventory/inventory.validation';
import type { CsvRecord } from './csv';
import {
  IMPORT_FIELDS,
  IMPORTABLE_TYPES,
  isImportableType,
  type ColumnMapping,
  type ImportableType,
  type ImportField,
  type ImportRow,
} from './imports.models';

/** Active catalog codes of the organization, keyed by lowercase code. */
export interface CatalogCodes {
  skus: Map<string, string>;
  warehouses: Map<string, string>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WHOLE_NUMBER = /^[+-]?\d{1,10}$/;

/** Trimmed values of the mapped columns of one record. */
export function mappedValues(
  header: string[],
  mapping: ColumnMapping,
  cells: string[],
): Partial<Record<ImportField, string>> {
  const values: Partial<Record<ImportField, string>> = {};
  for (const field of IMPORT_FIELDS) {
    const name = mapping[field];
    if (name === null) continue;
    values[field] = (cells[header.indexOf(name)] ?? '').trim();
  }
  return values;
}

/** Distinct, non-empty SKU and warehouse codes in the file, for one catalog lookup. */
export function codesInFile(
  header: string[],
  mapping: ColumnMapping,
  records: CsvRecord[],
): { skuCodes: string[]; warehouseCodes: string[] } {
  const skus = new Set<string>();
  const warehouses = new Set<string>();
  for (const record of records) {
    const values = mappedValues(header, mapping, record.cells);
    if (values.skuCode) skus.add(values.skuCode.toLowerCase());
    if (values.warehouseCode) warehouses.add(values.warehouseCode.toLowerCase());
  }
  return { skuCodes: [...skus], warehouseCodes: [...warehouses] };
}

function lookup(
  code: string | undefined,
  codes: Map<string, string>,
  field: ImportField,
  label: string,
  errors: FieldError[],
): string | null {
  if (!code) {
    errors.push({ field, message: 'is required' });
    return null;
  }
  const id = codes.get(code.toLowerCase());
  if (id === undefined) {
    errors.push({ field, message: `"${code}" is not an active ${label} code in this organization` });
    return null;
  }
  return id;
}

/**
 * Checks one record with the same rules as `POST .../inventory/movements`:
 * known active SKU and warehouse codes, a receipt/issue/adjustment type, a
 * quantity with the right sign and a reason for adjustments. A date without a
 * time (`2026-11-19`) is read as midnight UTC.
 */
export function previewRow(
  header: string[],
  mapping: ColumnMapping,
  defaultType: ImportableType | null,
  catalog: CatalogCodes,
  record: CsvRecord,
  now: Date,
): ImportRow {
  const values = mappedValues(header, mapping, record.cells);
  const errors: FieldError[] = [];
  if (record.cells.length !== header.length) {
    errors.push({
      field: 'row',
      message: `has ${record.cells.length} cells but the header has ${header.length}`,
    });
  }

  const skuId = lookup(values.skuCode, catalog.skus, 'skuCode', 'SKU', errors);
  const warehouseId = lookup(
    values.warehouseCode,
    catalog.warehouses,
    'warehouseCode',
    'warehouse',
    errors,
  );

  let type: ImportableType | null = null;
  const rawType = values.type ? values.type.toLowerCase() : defaultType;
  if (rawType === null) {
    errors.push({ field: 'type', message: 'is empty and no defaultType was given' });
  } else if (isImportableType(rawType)) {
    type = rawType;
  } else {
    errors.push({ field: 'type', message: `must be one of: ${IMPORTABLE_TYPES.join(', ')}` });
  }

  const quantityCell = values.quantity ?? '';
  const quantity = WHOLE_NUMBER.test(quantityCell) ? Number(quantityCell) : NaN;
  const delta = quantityDelta(type, quantity, errors);

  const text = { reason: values.reason || null, reference: values.reference || null };
  const reason = optionalText(text, 'reason', 500, errors);
  const reference = optionalText(text, 'reference', 120, errors);

  let occurredAt: string | null = null;
  if (values.occurredAt) {
    const stamp = DATE_ONLY.test(values.occurredAt)
      ? `${values.occurredAt}T00:00:00Z`
      : values.occurredAt;
    occurredAt = parseOccurredAt(stamp, now, errors);
  }

  if (type === 'adjustment' && reason === null && !errors.some((e) => e.field === 'reason')) {
    errors.push({ field: 'reason', message: 'is required for adjustments' });
  }

  const valid = errors.length === 0;
  return {
    rowNumber: record.rowNumber,
    status: valid ? 'valid' : 'invalid',
    cells: record.cells,
    values,
    movement: valid
      ? {
          skuId: skuId as string,
          warehouseId: warehouseId as string,
          type: type as ImportableType,
          quantityDelta: delta,
          reason,
          reference,
          occurredAt,
        }
      : null,
    errors,
  };
}

export function previewRows(
  header: string[],
  mapping: ColumnMapping,
  defaultType: ImportableType | null,
  catalog: CatalogCodes,
  records: CsvRecord[],
  now: Date = new Date(),
): ImportRow[] {
  return records.map((record) => previewRow(header, mapping, defaultType, catalog, record, now));
}
