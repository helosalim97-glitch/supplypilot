import type { FieldError } from '../http/api-error';
import {
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
} from './imports.models';

/** Lowercase letters and digits only, so "SKU code", "sku_code" and "SkuCode" match. */
export function normalizeHeader(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Normalized header names recognised for each field, most specific first. */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  skuCode: ['skucode', 'sku', 'itemcode', 'item', 'productcode', 'product'],
  warehouseCode: ['warehousecode', 'warehouse', 'locationcode', 'location', 'site'],
  type: ['type', 'movementtype', 'movement', 'eventtype'],
  quantity: ['quantity', 'qty', 'units'],
  reason: ['reason', 'note', 'notes', 'comment'],
  reference: ['reference', 'ref', 'ponumber', 'po', 'ordernumber', 'document'],
  occurredAt: ['occurredat', 'occurred', 'date', 'datetime', 'timestamp'],
};

export interface ResolvedMapping {
  mapping: ColumnMapping;
  errors: FieldError[];
}

/**
 * Combines explicit choices with automatic matching. A field given as a header
 * name uses that column; a field given as null is left out; any other field is
 * matched to the first unused header that is one of its aliases. Every
 * required field must end up mapped and no column may be used twice.
 */
export function resolveMapping(header: string[], requested: Partial<ColumnMapping>): ResolvedMapping {
  const errors: FieldError[] = [];
  const mapping = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, null])) as ColumnMapping;
  const byLowerName = new Map(header.map((name) => [name.toLowerCase(), name]));
  const used = new Map<string, ImportField>();

  const use = (field: ImportField, name: string): void => {
    const other = used.get(name);
    if (other) {
      errors.push({
        field: `mapping.${field}`,
        message: `column "${name}" is already mapped to ${other}`,
      });
      return;
    }
    used.set(name, field);
    mapping[field] = name;
  };

  for (const field of IMPORT_FIELDS) {
    const choice = requested[field];
    if (choice === undefined || choice === null) continue;
    const name = byLowerName.get(choice.trim().toLowerCase());
    if (name === undefined) {
      errors.push({ field: `mapping.${field}`, message: `column "${choice}" is not in the file` });
    } else {
      use(field, name);
    }
  }

  for (const field of IMPORT_FIELDS) {
    if (requested[field] !== undefined) continue;
    for (const alias of HEADER_ALIASES[field]) {
      const name = header.find((h) => normalizeHeader(h) === alias && !used.has(h));
      if (name !== undefined) {
        use(field, name);
        break;
      }
    }
  }

  for (const field of REQUIRED_IMPORT_FIELDS) {
    if (mapping[field] === null && !errors.some((e) => e.field === `mapping.${field}`)) {
      errors.push({
        field: `mapping.${field}`,
        message: 'is required: no column matched, name one in the mapping',
      });
    }
  }
  return { mapping, errors };
}
