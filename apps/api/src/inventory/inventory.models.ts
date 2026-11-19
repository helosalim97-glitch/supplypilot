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

/** Current on-hand stock of one SKU in one warehouse (`GET .../inventory`). */
export interface StockBalance {
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  onHand: number;
  reorderPoint: number;
  /** True when on-hand stock is at or below the SKU's reorder point. */
  atOrBelowReorderPoint: boolean;
  eventCount: number;
  lastEventId: string;
  lastMovementAt: string;
  updatedAt: string;
}

/** Filters and paging for the balance list. */
export interface BalanceQuery {
  skuId: string | null;
  warehouseId: string | null;
  limit: number;
  offset: number;
}

export interface StockBalanceRow {
  sku_id: string;
  sku_code: string;
  sku_name: string;
  unit: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  on_hand: number;
  reorder_point: number;
  event_count: number;
  last_event_id: string;
  last_occurred_at: Date;
  updated_at: Date;
}

export function toStockBalance(row: StockBalanceRow): StockBalance {
  return {
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    unit: row.unit,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    onHand: row.on_hand,
    reorderPoint: row.reorder_point,
    atOrBelowReorderPoint: row.on_hand <= row.reorder_point,
    eventCount: row.event_count,
    lastEventId: row.last_event_id,
    lastMovementAt: row.last_occurred_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
