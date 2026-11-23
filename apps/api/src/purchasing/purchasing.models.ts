/** Purchase orders as the API exposes them (camelCase, ISO timestamps). */

export const PURCHASE_ORDER_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
  'partially_received',
  'received',
] as const;

export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export interface PurchaseOrderLine {
  id: string;
  lineNumber: number;
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  quantityOrdered: number;
  unitCostCents: number;
  lineTotalCents: number;
}

/** One row of the order list: header plus line totals, without the lines. */
export interface PurchaseOrderSummary {
  id: string;
  organizationId: string;
  number: string;
  status: PurchaseOrderStatus;
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  /** Calendar date (YYYY-MM-DD) the delivery is expected, if known. */
  expectedOn: string | null;
  notes: string | null;
  createdBy: string;
  lineCount: number;
  totalUnits: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrder extends PurchaseOrderSummary {
  lines: PurchaseOrderLine[];
}

export interface NewPurchaseOrderLine {
  skuId: string;
  quantity: number;
  /** `null` = use the SKU's current catalog cost. */
  unitCostCents: number | null;
}

export interface NewPurchaseOrder {
  supplierId: string;
  warehouseId: string;
  expectedOn: string | null;
  notes: string | null;
  lines: NewPurchaseOrderLine[];
}

export interface PurchaseOrderQuery {
  status: PurchaseOrderStatus | null;
  supplierId: string | null;
  warehouseId: string | null;
  limit: number;
  offset: number;
}

/** Rows as returned by `pg`. Bigint sums arrive as strings. */
export interface PurchaseOrderRow {
  id: string;
  organization_id: string;
  number: string;
  status: PurchaseOrderStatus;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  expected_on: string | null;
  notes: string | null;
  created_by: string;
  line_count: number;
  total_units: string | number;
  total_cents: string | number;
  created_at: Date;
  updated_at: Date;
}

export interface PurchaseOrderLineRow {
  id: string;
  line_number: number;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  unit: string;
  quantity_ordered: number;
  unit_cost_cents: number;
  line_total_cents: string | number;
}

export function toPurchaseOrderSummary(row: PurchaseOrderRow): PurchaseOrderSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    number: row.number,
    status: row.status,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    supplierName: row.supplier_name,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    warehouseName: row.warehouse_name,
    expectedOn: row.expected_on,
    notes: row.notes,
    createdBy: row.created_by,
    lineCount: row.line_count,
    totalUnits: Number(row.total_units),
    totalCents: Number(row.total_cents),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toPurchaseOrderLine(row: PurchaseOrderLineRow): PurchaseOrderLine {
  return {
    id: row.id,
    lineNumber: row.line_number,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    unit: row.unit,
    quantityOrdered: row.quantity_ordered,
    unitCostCents: row.unit_cost_cents,
    lineTotalCents: Number(row.line_total_cents),
  };
}
