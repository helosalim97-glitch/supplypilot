import type { FieldError } from '../http/api-error';
import type { CsvDelimiter } from './csv';

/** Fields a CSV column can be mapped to when importing stock movements. */
export const IMPORT_FIELDS = [
  'skuCode',
  'warehouseCode',
  'type',
  'quantity',
  'reason',
  'reference',
  'occurredAt',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_IMPORT_FIELDS: readonly ImportField[] = ['skuCode', 'warehouseCode', 'quantity'];

/** Corrections need an event id, so they are recorded one by one, not imported. */
export const IMPORTABLE_TYPES = ['receipt', 'issue', 'adjustment'] as const;

export type ImportableType = (typeof IMPORTABLE_TYPES)[number];

export function isImportableType(value: unknown): value is ImportableType {
  return typeof value === 'string' && (IMPORTABLE_TYPES as readonly string[]).includes(value);
}

/** Import field -> CSV header name, or null when the field is not in the file. */
export type ColumnMapping = Record<ImportField, string | null>;

/** Validated body of `POST .../imports`. */
export interface NewImport {
  fileName: string;
  content: string;
  /** Explicit choices; fields left out are matched to headers automatically. */
  mapping: Partial<ColumnMapping>;
  defaultType: ImportableType | null;
}

/** The movement a valid row would record, with codes resolved to ids. */
export interface ImportedMovement {
  skuId: string;
  warehouseId: string;
  type: ImportableType;
  quantityDelta: number;
  reason: string | null;
  reference: string | null;
  occurredAt: string | null;
}

/** What applying did with a valid row; invalid rows are never applied. */
export type RowOutcomeKind = 'applied' | 'duplicate' | 'rejected';

export const ROW_OUTCOMES: readonly RowOutcomeKind[] = ['applied', 'duplicate', 'rejected'];

export interface RowOutcome {
  outcome: RowOutcomeKind;
  /** applied: the recorded event; duplicate: the event already in the ledger. */
  eventId: string | null;
  /** duplicate: the earlier row of the same file with the same movement. */
  duplicateOfRow: number | null;
  /** Why a row was skipped or rejected. */
  message: string | null;
}

export interface ImportRow {
  rowNumber: number;
  status: 'valid' | 'invalid';
  /** Cells exactly as they appear in the file. */
  cells: string[];
  /** Trimmed cell values of the mapped columns. */
  values: Partial<Record<ImportField, string>>;
  movement: ImportedMovement | null;
  errors: FieldError[];
  /** null until the row has been applied (and always for invalid rows). */
  outcome: RowOutcome | null;
}

export type ImportStatus = 'previewed' | 'queued' | 'applying' | 'applied' | 'failed';

export interface ImportBatch {
  id: string;
  organizationId: string;
  kind: 'stock_movements';
  fileName: string;
  fileSha256: string;
  delimiter: CsvDelimiter;
  columns: string[];
  mapping: ColumnMapping;
  defaultType: ImportableType | null;
  status: ImportStatus;
  rowCount: number;
  validCount: number;
  invalidCount: number;
  createdBy: string;
  createdAt: string;
  apply: ImportApplyState;
}

/** Progress of applying the batch; all null/zero while it is only previewed. */
export interface ImportApplyState {
  requestedBy: string | null;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  appliedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  failureReason: string | null;
}

/** Everything needed to store a previewed batch. */
export interface ImportDraft {
  fileName: string;
  fileSha256: string;
  delimiter: CsvDelimiter;
  columns: string[];
  mapping: ColumnMapping;
  defaultType: ImportableType | null;
  rows: ImportRow[];
}

export interface ImportRowQuery {
  status: 'valid' | 'invalid' | null;
  outcome: RowOutcomeKind | null;
  limit: number;
  offset: number;
}

export interface ImportBatchRow {
  id: string;
  organization_id: string;
  kind: 'stock_movements';
  file_name: string;
  file_sha256: string;
  delimiter: CsvDelimiter;
  columns: string[];
  column_mapping: ColumnMapping;
  default_type: ImportableType | null;
  status: ImportStatus;
  row_count: number;
  valid_count: number;
  created_by: string;
  created_at: Date;
  applied_by: string | null;
  queued_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  attempts: number;
  applied_count: number;
  duplicate_count: number;
  rejected_count: number;
  failure_reason: string | null;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toImportBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    fileName: row.file_name,
    fileSha256: row.file_sha256,
    delimiter: row.delimiter,
    columns: row.columns,
    mapping: row.column_mapping,
    defaultType: row.default_type,
    status: row.status,
    rowCount: row.row_count,
    validCount: row.valid_count,
    invalidCount: row.row_count - row.valid_count,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    apply: {
      requestedBy: row.applied_by,
      queuedAt: iso(row.queued_at),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      attempts: row.attempts,
      appliedCount: row.applied_count,
      duplicateCount: row.duplicate_count,
      rejectedCount: row.rejected_count,
      failureReason: row.failure_reason,
    },
  };
}

export interface ImportRowRecord {
  row_number: number;
  cells: string[];
  mapped_values: Partial<Record<ImportField, string>>;
  sku_id: string | null;
  warehouse_id: string | null;
  event_type: ImportableType | null;
  quantity_delta: number | null;
  reason: string | null;
  reference: string | null;
  occurred_at: Date | null;
  errors: FieldError[];
  outcome?: RowOutcomeKind | null;
  event_id?: string | null;
  duplicate_of_row?: number | null;
  outcome_message?: string | null;
}

export function toImportRow(row: ImportRowRecord): ImportRow {
  const valid = row.errors.length === 0;
  return {
    rowNumber: row.row_number,
    status: valid ? 'valid' : 'invalid',
    cells: row.cells,
    values: row.mapped_values,
    movement: valid
      ? {
          skuId: row.sku_id as string,
          warehouseId: row.warehouse_id as string,
          type: row.event_type as ImportableType,
          quantityDelta: row.quantity_delta as number,
          reason: row.reason,
          reference: row.reference,
          occurredAt: iso(row.occurred_at),
        }
      : null,
    errors: row.errors,
    outcome: row.outcome
      ? {
          outcome: row.outcome,
          eventId: row.event_id ?? null,
          duplicateOfRow: row.duplicate_of_row ?? null,
          message: row.outcome_message ?? null,
        }
      : null,
  };
}

/** Row shape written through `jsonb_to_recordset` (snake_case keys). */
export function toImportRowRecord(row: ImportRow): Record<string, unknown> {
  const m = row.movement;
  return {
    row_number: row.rowNumber,
    cells: row.cells,
    mapped_values: row.values,
    sku_id: m?.skuId ?? null,
    warehouse_id: m?.warehouseId ?? null,
    event_type: m?.type ?? null,
    quantity_delta: m?.quantityDelta ?? null,
    reason: m?.reason ?? null,
    reference: m?.reference ?? null,
    occurred_at: m?.occurredAt ?? null,
    errors: row.errors,
  };
}
