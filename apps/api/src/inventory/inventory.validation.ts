import { isUuid } from '../catalog/catalog.validation';
import { ValidationError, type FieldError } from '../http/api-error';
import {
  MOVEMENT_TYPES,
  type BalanceQuery,
  type MovementType,
  type NewMovement,
} from './inventory.models';

/*
 * Validation for `POST .../inventory/movements`. Rules mirror the CHECK
 * constraints in migration 0004, so bad input gets a 422 listing every
 * invalid field instead of a database error.
 */

/** Largest value a PostgreSQL `integer` column accepts. */
const MAX_INT = 2_147_483_647;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
/** ISO 8601 date-time with an explicit offset, e.g. 2026-11-19T08:30:00Z. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
/** Clock skew tolerated for `occurredAt` in the future. */
const MAX_FUTURE_MS = 5 * 60 * 1000;

const ALLOWED_FIELDS = [
  'skuId',
  'warehouseId',
  'type',
  'quantity',
  'reason',
  'reference',
  'occurredAt',
  'correctsEventId',
];

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** The `Idempotency-Key` header is required, so retries never double-count stock. */
export function parseIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ValidationError([
      {
        field: IDEMPOTENCY_HEADER,
        message: 'header is required: 8-100 letters, digits, ".", "_", ":" or "-"',
      },
    ]);
  }
  return value;
}

function isMovementType(value: unknown): value is MovementType {
  return typeof value === 'string' && (MOVEMENT_TYPES as readonly string[]).includes(value);
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  errors: FieldError[],
): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    errors.push({
      field,
      message: `must be null or a non-blank string of at most ${maxLength} characters`,
    });
    return null;
  }
  return trimmed;
}

function uuid(body: Record<string, unknown>, field: string, errors: FieldError[]): string {
  const value = body[field];
  if (typeof value !== 'string' || !isUuid(value)) {
    errors.push({ field, message: 'must be a UUID' });
    return '';
  }
  return value.toLowerCase();
}

/**
 * Receipts and issues take a positive `quantity` and the sign comes from the
 * type. Adjustments and corrections take a signed, non-zero `quantity`.
 */
function quantityDelta(type: MovementType | null, value: unknown, errors: FieldError[]): number {
  const n = typeof value === 'number' && Number.isInteger(value) ? value : NaN;
  if (type === 'receipt' || type === 'issue') {
    if (!(n >= 1 && n <= MAX_INT)) {
      errors.push({ field: 'quantity', message: `must be a whole number from 1 to ${MAX_INT}` });
      return 0;
    }
    return type === 'issue' ? -n : n;
  }
  if (!(n !== 0 && Math.abs(n) <= MAX_INT)) {
    errors.push({
      field: 'quantity',
      message: `must be a non-zero whole number from -${MAX_INT} to ${MAX_INT}`,
    });
    return 0;
  }
  return n;
}

function occurredAt(value: unknown, now: Date, errors: FieldError[]): string | null {
  if (value === undefined || value === null) return null;
  const time = typeof value === 'string' && TIMESTAMP_PATTERN.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) {
    errors.push({ field: 'occurredAt', message: 'must be an ISO 8601 date-time with a time zone' });
    return null;
  }
  if (time > now.getTime() + MAX_FUTURE_MS) {
    errors.push({ field: 'occurredAt', message: 'must not be in the future' });
    return null;
  }
  return new Date(time).toISOString();
}

export function parseNewMovement(body: unknown, now: Date = new Date()): NewMovement {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  const input = body as Record<string, unknown>;
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.includes(key)) errors.push({ field: key, message: 'is not an allowed field' });
  }

  const skuId = uuid(input, 'skuId', errors);
  const warehouseId = uuid(input, 'warehouseId', errors);

  let type: MovementType | null = null;
  if (isMovementType(input.type)) {
    type = input.type;
  } else {
    errors.push({ field: 'type', message: `must be one of: ${MOVEMENT_TYPES.join(', ')}` });
  }

  const delta = quantityDelta(type, input.quantity, errors);
  const reason = optionalText(input, 'reason', 500, errors);
  const reference = optionalText(input, 'reference', 120, errors);
  const occurred = occurredAt(input.occurredAt, now, errors);

  let correctsEventId: string | null = null;
  const target = input.correctsEventId;
  if (type === 'correction') {
    correctsEventId = uuid(input, 'correctsEventId', errors) || null;
  } else if (target !== undefined && target !== null) {
    errors.push({ field: 'correctsEventId', message: 'is only allowed on correction movements' });
  }

  if (type === 'adjustment' && reason === null && !errors.some((e) => e.field === 'reason')) {
    errors.push({ field: 'reason', message: 'is required for adjustments' });
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return {
    skuId,
    warehouseId,
    type: type as MovementType,
    quantityDelta: delta,
    reason,
    reference,
    correctsEventId,
    occurredAt: occurred,
  };
}

const BALANCE_QUERY_FIELDS = ['skuId', 'warehouseId', 'limit', 'offset'];
export const DEFAULT_BALANCE_LIMIT = 100;
export const MAX_BALANCE_LIMIT = 500;
const MAX_OFFSET = 100_000;

/** A whole number from a query-string value, or the fallback when absent. */
function queryInt(
  query: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  fallback: number,
  errors: FieldError[],
): number {
  const value = query[field];
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  if (!(n >= min && n <= max)) {
    errors.push({ field, message: `must be a whole number from ${min} to ${max}` });
    return fallback;
  }
  return n;
}

/** Query string of `GET .../inventory`: optional SKU/warehouse filters and paging. */
export function parseBalanceQuery(query: unknown): BalanceQuery {
  const input =
    typeof query === 'object' && query !== null ? (query as Record<string, unknown>) : {};
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!BALANCE_QUERY_FIELDS.includes(key)) {
      errors.push({ field: key, message: 'is not an allowed query parameter' });
    }
  }
  const filter = (field: string): string | null =>
    input[field] === undefined ? null : uuid(input, field, errors) || null;

  const skuId = filter('skuId');
  const warehouseId = filter('warehouseId');
  const limit = queryInt(input, 'limit', 1, MAX_BALANCE_LIMIT, DEFAULT_BALANCE_LIMIT, errors);
  const offset = queryInt(input, 'offset', 0, MAX_OFFSET, 0, errors);

  if (errors.length > 0) throw new ValidationError(errors);
  return { skuId, warehouseId, limit, offset };
}
