/** Reorder proposals as the API exposes them (camelCase, ISO timestamps). */

export const REORDER_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;

export type ReorderProposalStatus = (typeof REORDER_PROPOSAL_STATUSES)[number];

export const REORDER_DECISIONS = ['approve', 'reject'] as const;

export type ReorderDecision = (typeof REORDER_DECISIONS)[number];

export interface ReorderProposal {
  id: string;
  organizationId: string;
  status: ReorderProposalStatus;
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  warehouseId: string;
  warehouseCode: string;
  supplierId: string;
  supplierCode: string;
  suggestedQty: number;
  onHand: number;
  onOrder: number;
  reorderPoint: number;
  safetyStock: number;
  orderUpTo: number;
  /** Demand, lead time and run settings behind the numbers. */
  evidence: Record<string, unknown>;
  warnings: string[];
  inputsDigest: string;
  calculatedAt: string;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  /** Quantity put on the draft order (the suggestion unless the manager changed it). */
  approvedQty: number | null;
  purchaseOrderId: string | null;
  purchaseOrderNumber: string | null;
  supersededAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReorderProposalRow {
  id: string;
  organization_id: string;
  status: ReorderProposalStatus;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  unit: string;
  warehouse_id: string;
  warehouse_code: string;
  supplier_id: string;
  supplier_code: string;
  suggested_qty: number;
  on_hand: number;
  on_order: number;
  reorder_point: number;
  safety_stock: number;
  order_up_to: number;
  evidence: Record<string, unknown>;
  warnings: string[];
  inputs_digest: string;
  calculated_at: Date;
  created_by: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  approved_qty: number | null;
  purchase_order_id: string | null;
  purchase_order_number: string | null;
  superseded_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toReorderProposal(row: ReorderProposalRow): ReorderProposal {
  return {
    id: row.id,
    organizationId: row.organization_id,
    status: row.status,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    unit: row.unit,
    warehouseId: row.warehouse_id,
    warehouseCode: row.warehouse_code,
    supplierId: row.supplier_id,
    supplierCode: row.supplier_code,
    suggestedQty: row.suggested_qty,
    onHand: row.on_hand,
    onOrder: row.on_order,
    reorderPoint: row.reorder_point,
    safetyStock: row.safety_stock,
    orderUpTo: row.order_up_to,
    evidence: row.evidence,
    warnings: row.warnings,
    inputsDigest: row.inputs_digest,
    calculatedAt: row.calculated_at.toISOString(),
    createdBy: row.created_by,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    decisionReason: row.decision_reason,
    approvedQty: row.approved_qty,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNumber: row.purchase_order_number,
    supersededAt: iso(row.superseded_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface ReorderProposalQuery {
  status: ReorderProposalStatus | null;
  skuId: string | null;
  warehouseId: string | null;
  limit: number;
  offset: number;
}

/** Settings of one reorder run; omitted values use the worker's defaults. */
export interface ReorderRunSettings {
  demandWindowDays?: number;
  leadTimeWindowDays?: number;
  serviceLevel?: number;
  reviewPeriodDays?: number;
}

/** One pair the worker recommends reordering, already checked by `parseWorkerCandidates`. */
export interface ReorderCandidate {
  skuId: string;
  warehouseId: string;
  supplierId: string;
  suggestedQty: number;
  onHand: number;
  onOrder: number;
  reorderPoint: number;
  safetyStock: number;
  orderUpTo: number;
  warnings: string[];
  digest: string;
  evidence: Record<string, unknown>;
}

export interface SkippedPair {
  skuId: string;
  skuCode: string;
  warehouseId: string;
  warehouseCode: string;
  reason: string;
}

export interface WorkerCandidates {
  calculatedAt: string;
  parameters: Record<string, unknown>;
  candidates: ReorderCandidate[];
  skipped: SkippedPair[];
}

export interface ReorderRunResult {
  calculatedAt: string;
  parameters: Record<string, unknown>;
  /** New proposals, including replacements of changed ones. */
  created: number;
  /** Open proposals whose numbers were the same, kept as they were. */
  unchanged: number;
  /** Open proposals replaced or no longer recommended. */
  superseded: number;
  skipped: SkippedPair[];
}

export interface DecisionInput {
  decision: ReorderDecision;
  reason: string | null;
  /** Approve only: order this many instead of the suggestion. */
  quantity: number | null;
  /** Approve only: expected delivery date for the draft order. */
  expectedOn: string | null;
}
