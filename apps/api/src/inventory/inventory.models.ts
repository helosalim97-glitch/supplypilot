/** Stock ledger records as the API exposes them (camelCase, ISO timestamps). */

export const MOVEMENT_TYPES = ['receipt', 'issue', 'adjustment', 'correction'] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

export interface InventoryEvent {
  id: string;
  organizationId: string;
  skuId: string;
  warehouseId: string;
  type: MovementType;
  /** Signed change to on-hand stock: positive adds, negative removes. */
  quantityDelta: number;
  reason: string | null;
  reference: string | null;
  correctsEventId: string | null;
  createdBy: string;
  occurredAt: string;
  recordedAt: string;
}

/** A validated movement request, already converted to a signed delta. */
export interface NewMovement {
  skuId: string;
  warehouseId: string;
  type: MovementType;
  quantityDelta: number;
  reason: string | null;
  reference: string | null;
  correctsEventId: string | null;
  /** ISO timestamp; null means "now" (set by the database). */
  occurredAt: string | null;
}

/** Result of recording a movement: `replayed` is true for a repeated idempotency key. */
export interface RecordedMovement {
  event: InventoryEvent;
  replayed: boolean;
}

/** Rows as returned by `pg` (snake_case, Date timestamps). */
export interface InventoryEventRow {
  id: string;
  organization_id: string;
  sku_id: string;
  warehouse_id: string;
  event_type: MovementType;
  quantity_delta: number;
  reason: string | null;
  reference: string | null;
  corrects_event_id: string | null;
  created_by: string;
  occurred_at: Date;
  recorded_at: Date;
  request_hash: string;
}

export function toInventoryEvent(row: InventoryEventRow): InventoryEvent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    skuId: row.sku_id,
    warehouseId: row.warehouse_id,
    type: row.event_type,
    quantityDelta: row.quantity_delta,
    reason: row.reason,
    reference: row.reference,
    correctsEventId: row.corrects_event_id,
    createdBy: row.created_by,
    occurredAt: row.occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
  };
}
