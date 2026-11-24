import { isUuid } from '../catalog/catalog.validation';
import { ValidationError, type FieldError } from '../http/api-error';
import { optionalText, parseOccurredAt } from '../inventory/inventory.validation';
import {
  PURCHASE_ORDER_STATUSES,
  type NewPurchaseOrder,
  type NewPurchaseOrderLine,
  type NewReceipt,
  type NewReceiptLine,
  type PurchaseOrderQuery,
  type PurchaseOrderStatus,
} from './purchasing.models';
import { REASON_REQUIRED, type PurchaseOrderAction } from './purchasing.state-machine';

/*
 * Validation for purchase order writes and list queries. The limits mirror
 * the CHECK constraints in migration 0008, so bad input gets a 422 listing
 * every invalid field (`lines[2].quantity`, ...) instead of a database error.
 */

export const MAX_LINES = 200;
export const MAX_LINE_QUANTITY = 1_000_000;
/** Largest value a PostgreSQL `integer` column accepts. */
const MAX_INT = 2_147_483_647;
/** `purchase_order_lines_total_cap`: quantity × unit cost per line. */
export const MAX_LINE_TOTAL_CENTS = 10_000_000_000_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const ORDER_FIELDS = ['supplierId', 'warehouseId', 'expectedOn', 'notes', 'lines'];
const LINE_FIELDS = ['skuId', 'quantity', 'unitCostCents'];
const LINES_BODY_FIELDS = ['lines'];

type Body = Record<string, unknown>;

function isObject(value: unknown): value is Body {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectBody(body: unknown): Body {
  if (!isObject(body)) {
    throw new ValidationError([{ field: 'body', message: 'must be a JSON object' }]);
  }
  return body;
}

function rejectUnknown(body: Body, allowed: string[], prefix: string, errors: FieldError[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push({ field: prefix + key, message: 'is not an allowed field' });
  }
}

function uuid(value: unknown, field: string, errors: FieldError[]): string {
  if (typeof value !== 'string' || !isUuid(value)) {
    errors.push({ field, message: 'must be a UUID' });
    return '';
  }
  return value.toLowerCase();
}

/** A real calendar date in YYYY-MM-DD form (2026-02-30 is rejected). */
export function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    year <= 2999 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function optionalDate(body: Body, field: string, errors: FieldError[]): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    errors.push({ field, message: 'must be null or a calendar date (YYYY-MM-DD)' });
    return null;
  }
  return value;
}

function parseLine(value: unknown, index: number, errors: FieldError[]): NewPurchaseOrderLine {
  const prefix = `lines[${index}].`;
  if (!isObject(value)) {
    errors.push({ field: `lines[${index}]`, message: 'must be an object' });
    return { skuId: '', quantity: 0, unitCostCents: null };
  }
  rejectUnknown(value, LINE_FIELDS, prefix, errors);

  const skuId = uuid(value.skuId, `${prefix}skuId`, errors);

  const q = value.quantity;
  let quantity = 0;
  if (typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_LINE_QUANTITY) {
    quantity = q;
  } else {
    errors.push({
      field: `${prefix}quantity`,
      message: `must be a whole number from 1 to ${MAX_LINE_QUANTITY}`,
    });
  }

  const c = value.unitCostCents;
  let unitCostCents: number | null = null;
  if (c !== undefined && c !== null) {
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= MAX_INT) {
      unitCostCents = c;
      if (quantity > 0 && quantity * c > MAX_LINE_TOTAL_CENTS) {
        errors.push({
          field: `${prefix}unitCostCents`,
          message: `quantity × unit cost must not exceed ${MAX_LINE_TOTAL_CENTS} cents`,
        });
      }
    } else {
      errors.push({
        field: `${prefix}unitCostCents`,
        message: `must be null or a whole number from 0 to ${MAX_INT}`,
      });
    }
  }

  return { skuId, quantity, unitCostCents };
}

/** 1–200 lines, each SKU at most once. */
function parseLines(value: unknown, errors: FieldError[]): NewPurchaseOrderLine[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LINES) {
    errors.push({ field: 'lines', message: `must be an array of 1 to ${MAX_LINES} lines` });
    return [];
  }
  const lines = value.map((line, index) => parseLine(line, index, errors));
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    if (!line.skuId) return;
    if (seen.has(line.skuId)) {
      errors.push({ field: `lines[${index}].skuId`, message: 'appears on an earlier line' });
    }
    seen.add(line.skuId);
  });
  return lines;
}

/** Body of `POST .../purchase-orders`. */
export function parseNewPurchaseOrder(body: unknown): NewPurchaseOrder {
  const input = objectBody(body);
  const errors: FieldError[] = [];
  rejectUnknown(input, ORDER_FIELDS, '', errors);
  const order: NewPurchaseOrder = {
    supplierId: uuid(input.supplierId, 'supplierId', errors),
    warehouseId: uuid(input.warehouseId, 'warehouseId', errors),
    expectedOn: optionalDate(input, 'expectedOn', errors),
    notes: optionalText(input, 'notes', 1000, errors),
    lines: parseLines(input.lines, errors),
  };
  if (errors.length > 0) throw new ValidationError(errors);
  return order;
}

/** Body of `PUT .../purchase-orders/:id/lines`: the draft's complete new line list. */
export function parseLineReplacement(body: unknown): NewPurchaseOrderLine[] {
  const input = objectBody(body);
  const errors: FieldError[] = [];
  rejectUnknown(input, LINES_BODY_FIELDS, '', errors);
  const lines = parseLines(input.lines, errors);
  if (errors.length > 0) throw new ValidationError(errors);
  return lines;
}

export const MAX_REASON_LENGTH = 500;
const TRANSITION_FIELDS = ['reason'];

/**
 * Body of `POST .../purchase-orders/:id/{submit,approve,reject,cancel,reopen}`:
 * an optional `reason`, required to reject or cancel. An empty body is fine
 * where no reason is needed.
 */
export function parseTransition(
  action: PurchaseOrderAction,
  body: unknown,
): { reason: string | null } {
  const input = body === undefined || body === null ? {} : objectBody(body);
  const errors: FieldError[] = [];
  rejectUnknown(input, TRANSITION_FIELDS, '', errors);
  const reason = optionalText(input, 'reason', MAX_REASON_LENGTH, errors);
  const reasonInvalid = errors.some((e) => e.field === 'reason');
  if (reason === null && REASON_REQUIRED.has(action) && !reasonInvalid) {
    errors.push({ field: 'reason', message: `is required to ${action} a purchase order` });
  }
  if (errors.length > 0) throw new ValidationError(errors);
  return { reason };
}

const QUERY_FIELDS = ['status', 'supplierId', 'warehouseId', 'limit', 'offset'];
export const DEFAULT_ORDER_LIMIT = 50;
export const MAX_ORDER_LIMIT = 200;
const MAX_OFFSET = 100_000;

function isStatus(value: unknown): value is PurchaseOrderStatus {
  return typeof value === 'string' && (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value);
}

function queryInt(
  query: Body,
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

/** Query string of `GET .../purchase-orders`. */
export function parsePurchaseOrderQuery(query: unknown): PurchaseOrderQuery {
  const input = isObject(query) ? query : {};
  const errors: FieldError[] = [];
  for (const key of Object.keys(input)) {
    if (!QUERY_FIELDS.includes(key)) {
      errors.push({ field: key, message: 'is not an allowed query parameter' });
    }
  }

  let status: PurchaseOrderStatus | null = null;
  if (input.status !== undefined) {
    if (isStatus(input.status)) status = input.status;
    else errors.push({ field: 'status', message: `must be one of ${PURCHASE_ORDER_STATUSES.join(', ')}` });
  }
  const filter = (field: string): string | null =>
    input[field] === undefined ? null : uuid(input[field], field, errors) || null;

  const result: PurchaseOrderQuery = {
    status,
    supplierId: filter('supplierId'),
    warehouseId: filter('warehouseId'),
    limit: queryInt(input, 'limit', 1, MAX_ORDER_LIMIT, DEFAULT_ORDER_LIMIT, errors),
    offset: queryInt(input, 'offset', 0, MAX_OFFSET, 0, errors),
  };
  if (errors.length > 0) throw new ValidationError(errors);
  return result;
}

const RECEIPT_FIELDS = ['lines', 'reference', 'notes', 'receivedAt'];
const RECEIPT_LINE_FIELDS = ['lineId', 'quantity'];

function parseReceiptLine(value: unknown, index: number, errors: FieldError[]): NewReceiptLine {
  const prefix = `lines[${index}].`;
  if (!isObject(value)) {
    errors.push({ field: `lines[${index}]`, message: 'must be an object' });
    return { lineId: '', quantity: 0 };
  }
  rejectUnknown(value, RECEIPT_LINE_FIELDS, prefix, errors);
  const lineId = uuid(value.lineId, `${prefix}lineId`, errors);
  const q = value.quantity;
  if (typeof q === 'number' && Number.isInteger(q) && q >= 1 && q <= MAX_LINE_QUANTITY) {
    return { lineId, quantity: q };
  }
  errors.push({
    field: `${prefix}quantity`,
    message: `must be a whole number from 1 to ${MAX_LINE_QUANTITY}`,
  });
  return { lineId, quantity: 0 };
}

/**
 * Body of `POST .../purchase-orders/:id/receipts`: 1–200 lines of
 * `{ lineId, quantity }`, each order line at most once, plus an optional
 * delivery `reference`, `notes` and `receivedAt` (not in the future).
 * Whether the quantities fit what is still outstanding is checked against
 * the order itself (see receiving.ts).
 */
export function parseNewReceipt(body: unknown, now: Date = new Date()): NewReceipt {
  const input = objectBody(body);
  const errors: FieldError[] = [];
  rejectUnknown(input, RECEIPT_FIELDS, '', errors);

  let lines: NewReceiptLine[] = [];
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > MAX_LINES) {
    errors.push({ field: 'lines', message: `must be an array of 1 to ${MAX_LINES} lines` });
  } else {
    lines = input.lines.map((line, index) => parseReceiptLine(line, index, errors));
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      if (!line.lineId) return;
      if (seen.has(line.lineId)) {
        errors.push({ field: `lines[${index}].lineId`, message: 'appears on an earlier line' });
      }
      seen.add(line.lineId);
    });
  }

  const receipt: NewReceipt = {
    lines,
    reference: optionalText(input, 'reference', 120, errors),
    notes: optionalText(input, 'notes', 1000, errors),
    receivedAt: parseOccurredAt(input.receivedAt, now, errors, 'receivedAt'),
  };
  if (errors.length > 0) throw new ValidationError(errors);
  return receipt;
}
