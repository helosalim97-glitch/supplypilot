/*
 * Purchase order shapes and rules as the web app needs them. Free of I/O so
 * the pages, the server actions and the tests share one definition.
 *
 * The role/status rules mirror apps/api/src/purchasing/purchasing.state-machine.ts
 * and receiving.ts. They only decide which buttons to show: the API checks
 * everything again and its answer wins.
 */

export const ROLES = ['viewer', 'buyer', 'manager', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** True when `actual` is the same as or higher than `required`. */
export function satisfiesRole(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) >= ROLES.indexOf(required);
}

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

export function isStatus(value: unknown): value is PurchaseOrderStatus {
  return (
    typeof value === 'string' && (PURCHASE_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  submitted: 'Awaiting approval',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  partially_received: 'Partially received',
  received: 'Received',
};

export interface Membership {
  organizationId: string;
  slug: string;
  name: string;
  role: Role;
}

export interface PurchaseOrderLine {
  id: string;
  lineNumber: number;
  skuId: string;
  skuCode: string;
  skuName: string;
  unit: string;
  quantityOrdered: number;
  quantityReceived: number;
  quantityOutstanding: number;
  unitCostCents: number;
  lineTotalCents: number;
}

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
  expectedOn: string | null;
  notes: string | null;
  createdBy: string;
  submittedBy: string | null;
  submittedAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  lineCount: number;
  totalUnits: number;
  totalUnitsReceived: number;
  totalCents: number;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrder extends PurchaseOrderSummary {
  lines: PurchaseOrderLine[];
}

export interface AuditEvent {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
  details: Record<string, unknown>;
  occurredAt: string;
}

export interface Receipt {
  id: string;
  purchaseOrderId: string;
  reference: string | null;
  notes: string | null;
  receivedBy: string;
  receivedAt: string;
  recordedAt: string;
  lines: {
    purchaseOrderLineId: string;
    lineNumber: number;
    skuId: string;
    skuCode: string;
    quantity: number;
    inventoryEventId: string;
  }[];
}

export const PURCHASE_ORDER_ACTIONS = ['submit', 'approve', 'reject', 'cancel', 'reopen'] as const;
export type PurchaseOrderAction = (typeof PURCHASE_ORDER_ACTIONS)[number];

export function isAction(value: unknown): value is PurchaseOrderAction {
  return (
    typeof value === 'string' && (PURCHASE_ORDER_ACTIONS as readonly string[]).includes(value)
  );
}

interface Edge {
  from: PurchaseOrderStatus;
  role: Role;
}

const EDGES: Record<PurchaseOrderAction, Edge[]> = {
  submit: [{ from: 'draft', role: 'buyer' }],
  approve: [{ from: 'submitted', role: 'manager' }],
  reject: [{ from: 'submitted', role: 'manager' }],
  cancel: [
    { from: 'draft', role: 'buyer' },
    { from: 'submitted', role: 'buyer' },
    { from: 'approved', role: 'manager' },
  ],
  reopen: [{ from: 'rejected', role: 'buyer' }],
};

export const REASON_REQUIRED: ReadonlySet<PurchaseOrderAction> = new Set(['reject', 'cancel']);

export const ACTION_LABELS: Record<PurchaseOrderAction, string> = {
  submit: 'Submit for approval',
  approve: 'Approve',
  reject: 'Reject',
  cancel: 'Cancel order',
  reopen: 'Reopen as draft',
};

/** Notice shown after the API accepted an action. */
export const ACTION_NOTICES: Record<PurchaseOrderAction | 'received', string> = {
  submit: 'Submitted for approval.',
  approve: 'Purchase order approved.',
  reject: 'Purchase order rejected.',
  cancel: 'Purchase order cancelled.',
  reopen: 'Reopened as a draft.',
  received: 'Delivery recorded and stock updated.',
};

/** Status-change actions the role could take on an order in this status. */
export function availableActions(status: PurchaseOrderStatus, role: Role): PurchaseOrderAction[] {
  return PURCHASE_ORDER_ACTIONS.filter((action) =>
    EDGES[action].some((edge) => edge.from === status && satisfiesRole(role, edge.role)),
  );
}

export const RECEIVABLE_STATUSES: ReadonlySet<PurchaseOrderStatus> = new Set([
  'approved',
  'partially_received',
]);

/** Buyers and above can book deliveries against approved, not yet fully received orders. */
export function canReceive(order: PurchaseOrderSummary, role: Role): boolean {
  return (
    satisfiesRole(role, 'buyer') &&
    RECEIVABLE_STATUSES.has(order.status) &&
    order.totalUnitsReceived < order.totalUnits
  );
}

const MONEY = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 → "1,234.56" (amounts are stored in cents). */
export function formatCents(cents: number): string {
  return MONEY.format(cents / 100);
}

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** ISO timestamp → "24 Nov 2026, 14:05 UTC". */
export function formatDateTime(iso: string): string {
  return `${DATE_TIME.format(new Date(iso))} UTC`;
}

/** `purchase_order.goods_received` → "Goods received". */
export function describeAuditAction(action: string): string {
  const name = action.includes('.') ? action.slice(action.indexOf('.') + 1) : action;
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const PAGE_SIZE = 25;

export interface ListParams {
  status: PurchaseOrderStatus | null;
  offset: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Reads the list page's URL; anything unexpected falls back to the defaults. */
export function parseListParams(searchParams: SearchParams): ListParams {
  const status = first(searchParams.status);
  const offsetRaw = first(searchParams.offset) ?? '';
  const offset = /^\d{1,6}$/.test(offsetRaw) ? Number(offsetRaw) : 0;
  return { status: isStatus(status) ? status : null, offset: offset - (offset % PAGE_SIZE) };
}

/** Query string for the list page (only non-default values). */
export function listHref(base: string, params: ListParams): string {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.offset > 0) query.set('offset', String(params.offset));
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

/** Query string for `GET /v1/organizations/:orgId/purchase-orders`. */
export function listApiQuery(params: ListParams): string {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(params.offset) });
  if (params.status) query.set('status', params.status);
  return query.toString();
}

export interface ReceiptPayload {
  lines: { lineId: string; quantity: number }[];
  reference: string | null;
  notes: string | null;
}

export type FieldErrors = Record<string, string>;

/** Form field holding the quantity received for one order line. */
export function quantityField(lineId: string): string {
  return `qty:${lineId}`;
}

function text(value: FormDataEntryValue | null, max: number): string | null | undefined {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? undefined : trimmed;
}

/**
 * Turns the receiving form into the API body. Blank and zero quantities are
 * skipped, so one form handles partial deliveries; errors are keyed by form
 * field so they can be shown next to the input.
 */
export function buildReceiptPayload(
  form: Pick<FormData, 'get'>,
  lines: Pick<PurchaseOrderLine, 'id' | 'quantityOutstanding'>[],
): { payload: ReceiptPayload } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const received: ReceiptPayload['lines'] = [];

  for (const line of lines) {
    const field = quantityField(line.id);
    const raw = form.get(field);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '' || /^0+$/.test(value)) continue;
    if (!/^\d{1,7}$/.test(value)) {
      errors[field] = 'Enter a whole number of units';
      continue;
    }
    const quantity = Number(value);
    if (quantity > line.quantityOutstanding) {
      errors[field] = `Only ${line.quantityOutstanding} outstanding`;
      continue;
    }
    received.push({ lineId: line.id, quantity });
  }

  const reference = text(form.get('reference'), 120);
  if (reference === undefined) errors.reference = 'At most 120 characters';
  const notes = text(form.get('notes'), 1000);
  if (notes === undefined) errors.notes = 'At most 1000 characters';

  if (Object.keys(errors).length === 0 && received.length === 0) {
    errors.form = 'Enter the quantity received for at least one line';
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { payload: { lines: received, reference: reference ?? null, notes: notes ?? null } };
}

/**
 * Maps the API's field errors (`lines[1].quantity`) back to form fields,
 * using the lines that were sent. Unknown fields go to `form`.
 */
export function mapReceiptErrors(
  details: { field: string; message: string }[],
  sent: ReceiptPayload['lines'],
): FieldErrors {
  const errors: FieldErrors = {};
  for (const detail of details) {
    const match = /^lines\[(\d+)\]\.\w+$/.exec(detail.field);
    const line = match ? sent[Number(match[1])] : undefined;
    const field = line
      ? quantityField(line.lineId)
      : detail.field === 'reference' || detail.field === 'notes'
        ? detail.field
        : 'form';
    errors[field] = errors[field] ? `${errors[field]}; ${detail.message}` : detail.message;
  }
  return errors;
}

/** Reason entered for a status change; required for reject and cancel. */
export function parseReason(
  action: PurchaseOrderAction,
  raw: FormDataEntryValue | null,
): { reason: string | null } | { error: string } {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length > 500) return { error: 'At most 500 characters' };
  if (reason === '' && REASON_REQUIRED.has(action)) {
    return { error: `A reason is required to ${action} an order` };
  }
  return { reason: reason === '' ? null : reason };
}
