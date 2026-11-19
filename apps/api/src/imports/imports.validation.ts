import { ValidationError, type FieldError } from '../http/api-error';
import type { CsvLimits } from './csv';
import {
  IMPORT_FIELDS,
  IMPORTABLE_TYPES,
  isImportableType,
  type ColumnMapping,
  type ImportField,
  type ImportRowQuery,
  type NewImport,
} from './imports.models';

/*
 * Validation for `POST .../imports` and `GET .../imports/:importId`. The CSV
 * itself is checked by the reader in csv.ts; this file only checks the
 * request around it.
 */

export const CSV_LIMITS: CsvLimits = { maxRows: 2000, maxColumns: 30, maxCellLength: 500 };

const ALLOWED_FIELDS = ['fileName', 'content', 'mapping', 'defaultType'];
const MAX_FILE_NAME = 255;
const MAX_HEADER_NAME = 100;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMapping(value: unknown, errors: FieldError[]): Partial<ColumnMapping> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    errors.push({ field: 'mapping', message: 'must be an object of field: column name' });
    return {};
  }
  const mapping: Partial<ColumnMapping> = {};
  for (const [key, choice] of Object.entries(value)) {
    if (!(IMPORT_FIELDS as readonly string[]).includes(key)) {
      errors.push({
        field: `mapping.${key}`,
        message: `is not an import field (${IMPORT_FIELDS.join(', ')})`,
      });
      continue;
    }
    if (choice === null) {
      mapping[key as ImportField] = null;
    } else if (
      typeof choice === 'string' &&
      choice.trim().length >= 1 &&
      choice.length <= MAX_HEADER_NAME
    ) {
      mapping[key as ImportField] = choice;
    } else {
      errors.push({
        field: `mapping.${key}`,
        message: `must be null or a column name of at most ${MAX_HEADER_NAME} characters`,
      });
    }
  }
  return mapping;
}

export function parseNewImport(body: unknown): NewImport {
  if (!isPlainObject(body)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const errors: FieldError[] = [];
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.includes(key)) errors.push({ field: key, message: 'is not an allowed field' });
  }

  const rawName = body.fileName;
  const fileName = typeof rawName === 'string' ? rawName.trim() : '';
  if (fileName.length < 1 || fileName.length > MAX_FILE_NAME) {
    errors.push({
      field: 'fileName',
      message: `must be a non-blank string of at most ${MAX_FILE_NAME} characters`,
    });
  }

  const content = body.content;
  if (typeof content !== 'string' || content.trim() === '') {
    errors.push({ field: 'content', message: 'must be the CSV text of the file' });
  }

  const mapping = parseMapping(body.mapping, errors);

  let defaultType: NewImport['defaultType'] = null;
  const rawType = body.defaultType;
  if (rawType !== undefined && rawType !== null) {
    if (isImportableType(rawType)) {
      defaultType = rawType;
    } else {
      errors.push({ field: 'defaultType', message: `must be one of: ${IMPORTABLE_TYPES.join(', ')}` });
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return { fileName, content: content as string, mapping, defaultType };
}

const ROW_QUERY_FIELDS = ['status', 'limit', 'offset'];
export const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT = 500;

/** Query string of `GET .../imports/:importId`: optional status filter and paging. */
export function parseImportRowQuery(query: unknown): ImportRowQuery {
  const input: Record<string, unknown> = isPlainObject(query) ? query : {};
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!ROW_QUERY_FIELDS.includes(key)) {
      errors.push({ field: key, message: 'is not an allowed query parameter' });
    }
  }

  let status: ImportRowQuery['status'] = null;
  const rawStatus = input.status;
  if (rawStatus !== undefined) {
    if (rawStatus === 'valid' || rawStatus === 'invalid') status = rawStatus;
    else errors.push({ field: 'status', message: 'must be valid or invalid' });
  }

  const int = (field: string, min: number, max: number, fallback: number): number => {
    const value = input[field];
    if (value === undefined) return fallback;
    const n = typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
    if (!(n >= min && n <= max)) {
      errors.push({ field, message: `must be a whole number from ${min} to ${max}` });
      return fallback;
    }
    return n;
  };
  const limit = int('limit', 1, MAX_ROW_LIMIT, DEFAULT_ROW_LIMIT);
  const offset = int('offset', 0, CSV_LIMITS.maxRows, 0);

  if (errors.length > 0) throw new ValidationError(errors);
  return { status, limit, offset };
}
