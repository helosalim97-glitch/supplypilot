import { createHash } from 'node:crypto';
import type { NewReceipt, PurchaseOrderStatus } from './purchasing.models';

/*
 * Rules for receiving goods against a purchase order, kept free of I/O so
 * the repository and the tests share them. The repository runs them with the
 * order row locked, and migration 0011's CHECK on quantity_received backs up
 * the over-receipt rule in the database.
 */

/** Statuses an order can receive goods in. */
export const RECEIVABLE_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  'approved',
  'partially_received',
]);

/** What the planner needs to know about each line of the order. */
export interface ReceivableLine {
  id: string;
  lineNumber: number;
  skuId: string;
  quantityOrdered: number;
  quantityReceived: number;
}

export interface PlannedReceiptLine {
  line: ReceivableLine;
  quantity: number;
}

export interface ReceiptPlan {
  lines: PlannedReceiptLine[];
  /** Status after the receipt: `received` once every line is complete. */
  nextStatus: PurchaseOrderStatus;
  units: number;
}

/** The order isn't approved (or already fully received), so nothing can be received. */
export class PurchaseOrderNotReceivableError extends Error {
  constructor(readonly status: PurchaseOrderStatus) {
    super(
      status === 'received'
        ? 'The purchase order has already been received in full'
        : `Only approved purchase orders can receive goods (status: ${status.replace('_', ' ')})`,
    );
    this.name = 'PurchaseOrderNotReceivableError';
  }
}

/** A receipt line names a line that isn't on this order. */
export class UnknownOrderLineError extends Error {
  constructor(readonly index: number) {
    super(`lines[${index}].lineId is not a line of this purchase order`);
    this.name = 'UnknownOrderLineError';
  }
}

/** A receipt line would take a line past its ordered quantity. */
export class OverReceiptError extends Error {
  constructor(
    readonly index: number,
    readonly outstanding: number,
  ) {
    super(
      `lines[${index}].quantity is more than the ${outstanding} unit(s) still outstanding on that line`,
    );
    this.name = 'OverReceiptError';
  }
}

export function outstanding(line: ReceivableLine): number {
  return line.quantityOrdered - line.quantityReceived;
}

/**
 * Checks a delivery against the order and works out the order's next status.
 * Over-receipt is refused rather than tolerated: extra units are a
 * conversation with the supplier, not something to book silently.
 */
export function planReceipt(
  status: PurchaseOrderStatus,
  orderLines: ReceivableLine[],
  requested: NewReceipt['lines'],
): ReceiptPlan {
  if (!RECEIVABLE_STATUSES.has(status)) throw new PurchaseOrderNotReceivableError(status);

  const byId = new Map(orderLines.map((line) => [line.id, line]));
  const planned = requested.map((item, index): PlannedReceiptLine => {
    const line = byId.get(item.lineId);
    if (!line) throw new UnknownOrderLineError(index);
    if (item.quantity > outstanding(line)) throw new OverReceiptError(index, outstanding(line));
    return { line, quantity: item.quantity };
  });

  const received = new Map(planned.map((p) => [p.line.id, p.quantity]));
  const complete = orderLines.every(
    (line) => line.quantityReceived + (received.get(line.id) ?? 0) === line.quantityOrdered,
  );
  return {
    lines: planned,
    nextStatus: complete ? 'received' : 'partially_received',
    units: planned.reduce((sum, p) => sum + p.quantity, 0),
  };
}

/**
 * SHA-256 of the normalized delivery. The same Idempotency-Key with the same
 * hash is a retry; with another hash it is a conflict. Lines are sorted, so
 * listing them in another order is still the same delivery.
 */
export function receiptHash(orderId: string, input: NewReceipt): string {
  const lines = [...input.lines]
    .sort((a, b) => a.lineId.localeCompare(b.lineId))
    .map((l) => [l.lineId, l.quantity]);
  const canonical = JSON.stringify([
    orderId,
    lines,
    input.reference,
    input.notes,
    input.receivedAt,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** Ledger idempotency key of one receipt line, e.g. `po-receipt:<receiptId>:3`. */
export function receiptEventKey(receiptId: string, lineNumber: number): string {
  return `po-receipt:${receiptId}:${lineNumber}`;
}
