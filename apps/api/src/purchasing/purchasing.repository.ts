import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Role } from '../auth/roles';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { PG_POOL } from '../database/database.module';
import {
  IdempotencyConflictError,
  StockOverflowError,
  movementHash,
} from '../inventory/inventory.repository';
import {
  toAuditEvent,
  toReceipt,
  toPurchaseOrderLine,
  toPurchaseOrderSummary,
  type AuditEvent,
  type AuditEventRow,
  type NewPurchaseOrder,
  type NewPurchaseOrderLine,
  type NewReceipt,
  type PurchaseOrder,
  type PurchaseOrderLineRow,
  type PurchaseOrderQuery,
  type PurchaseOrderRow,
  type PurchaseOrderStatus,
  type PurchaseOrderSummary,
  type Receipt,
  type ReceiptLineRow,
  type ReceiptRow,
  type RecordedReceipt,
} from './purchasing.models';
import {
  AUDIT_ACTION,
  planTransition,
  type PurchaseOrderAction,
} from './purchasing.state-machine';
import { planReceipt, receiptEventKey, receiptHash, type ReceivableLine } from './receiving';

/** The order exists but is no longer a draft, so its lines are frozen. */
export class PurchaseOrderNotEditableError extends Error {
  constructor(readonly status: PurchaseOrderStatus) {
    super(`Purchase order lines can only change while the order is a draft (status: ${status})`);
    this.name = 'PurchaseOrderNotEditableError';
  }
}

/** A line's quantity × unit cost is above `purchase_order_lines_total_cap`. */
export class LineTotalTooLargeError extends Error {
  constructor() {
    super('A line total (quantity × unit cost) is too large');
    this.name = 'LineTotalTooLargeError';
  }
}

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
const RECEIPT_KEY_CONSTRAINT = 'purchase_order_receipts_organization_id_idempotency_key_key';
const LINE_TOTAL_CONSTRAINT = 'purchase_order_lines_total_cap';

function pgError(error: unknown): { code?: string; constraint?: string } {
  return typeof error === 'object' && error !== null
    ? (error as { code?: string; constraint?: string })
    : {};
}

/** Header columns plus line totals; `$1` is always the organization id. */
const ORDER_SELECT = `SELECT po.id, po.organization_id, po.number, po.status,
       po.supplier_id, s.code AS supplier_code, s.name AS supplier_name,
       po.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
       po.expected_on::text AS expected_on, po.notes, po.created_by,
       po.submitted_by, po.submitted_at, po.decided_by, po.decided_at, po.decision_reason,
       t.line_count, t.total_units, t.total_units_received, t.total_cents,
       po.created_at, po.updated_at
  FROM purchase_orders po
  JOIN suppliers s ON s.organization_id = po.organization_id AND s.id = po.supplier_id
  JOIN warehouses w ON w.organization_id = po.organization_id AND w.id = po.warehouse_id
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS line_count,
           coalesce(sum(l.quantity_ordered), 0)::bigint AS total_units,
           coalesce(sum(l.quantity_received), 0)::bigint AS total_units_received,
           coalesce(sum(l.line_total_cents), 0)::bigint AS total_cents
      FROM purchase_order_lines l
     WHERE l.organization_id = po.organization_id AND l.purchase_order_id = po.id
  ) t
 WHERE po.organization_id = $1`;

const RECEIPT_SELECT = `SELECT r.id, r.purchase_order_id, r.reference, r.notes, r.received_by,
       r.received_at, r.recorded_at, r.request_hash
  FROM purchase_order_receipts r`;

/**
 * Columns each action sets besides `status` ($1 org, $2 order, $3 status are
 * fixed; the action's own values follow). Only parameters a statement uses
 * are sent, so PostgreSQL can infer every parameter's type.
 */
function transitionSet(
  action: PurchaseOrderAction,
  actorId: string,
  reason: string | null,
): { set: string; values: (string | null)[] } {
  switch (action) {
    case 'submit':
      return {
        set: `submitted_by = $4, submitted_at = now(),
              decided_by = NULL, decided_at = NULL, decision_reason = NULL`,
        values: [actorId],
      };
    case 'approve':
    case 'reject':
      return {
        set: 'decided_by = $4, decided_at = now(), decision_reason = $5',
        values: [actorId, reason],
      };
    case 'reopen':
      // Back to an editable draft: the next submission starts a fresh approval.
      return {
        set: `submitted_by = NULL, submitted_at = NULL,
              decided_by = NULL, decided_at = NULL, decision_reason = NULL`,
        values: [],
      };
    case 'cancel':
      // The reason is kept in the audit trail.
      return { set: '', values: [] };
  }
}

export interface TransitionInput {
  action: PurchaseOrderAction;
  actorId: string;
  actorRole: Role;
  reason: string | null;
}

/** What both a pool and a checked-out client offer. */
export interface Queryable {
  query<R extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

/**
 * Purchase orders and their lines. Every query is scoped by organization id.
 * Writes run in one transaction: the supplier, warehouse and SKUs are checked
 * (and share-locked so they can't be archived halfway), then the order and
 * its lines are written together, so a failure leaves nothing behind.
 */
@Injectable()
export class PurchasingRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pick<Pool, 'query' | 'connect'>) {}

  async listOrders(
    organizationId: string,
    query: PurchaseOrderQuery,
  ): Promise<{ orders: PurchaseOrderSummary[]; hasMore: boolean }> {
    const { rows } = await this.pool.query<PurchaseOrderRow>(
      `${ORDER_SELECT}
         AND ($2::text IS NULL OR po.status = $2)
         AND ($3::uuid IS NULL OR po.supplier_id = $3)
         AND ($4::uuid IS NULL OR po.warehouse_id = $4)
       ORDER BY po.created_at DESC, po.number DESC
       LIMIT $5 OFFSET $6`,
      [
        organizationId,
        query.status,
        query.supplierId,
        query.warehouseId,
        query.limit + 1,
        query.offset,
      ],
    );
    return {
      orders: rows.slice(0, query.limit).map(toPurchaseOrderSummary),
      hasMore: rows.length > query.limit,
    };
  }

  async findOrder(organizationId: string, id: string): Promise<PurchaseOrder | null> {
    return this.readOrder(this.pool, organizationId, id);
  }

  /** Creates a draft with the next order number of the organization. */
  async createOrder(
    organizationId: string,
    userId: string,
    input: NewPurchaseOrder,
  ): Promise<PurchaseOrder> {
    return this.transaction((client) => this.createOrderIn(client, organizationId, userId, input));
  }

  /**
   * Creates a draft inside the caller's transaction, so another write (e.g.
   * approving a reorder proposal) and the new order commit or fail together.
   * `auditDetails` are added to the `purchase_order.created` event.
   */
  async createOrderIn(
    client: Queryable,
    organizationId: string,
    userId: string,
    input: NewPurchaseOrder,
    auditDetails: Record<string, unknown> = {},
  ): Promise<PurchaseOrder> {
    const supplier = await client.query(
      `SELECT 1 FROM suppliers
        WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR SHARE`,
      [organizationId, input.supplierId],
    );
    if (!supplier.rows[0]) throw new UnknownReferenceError('supplierId');
    const warehouse = await client.query(
      `SELECT 1 FROM warehouses
        WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR SHARE`,
      [organizationId, input.warehouseId],
    );
    if (!warehouse.rows[0]) throw new UnknownReferenceError('warehouseId');

    const costs = await this.lockSkus(client, organizationId, input.lines);

    // The row lock on the counter serializes concurrent creates per organization.
    const numbered = await client.query<{ last_number: number }>(
      `INSERT INTO purchase_order_numbers (organization_id, last_number) VALUES ($1, 1)
       ON CONFLICT (organization_id)
       DO UPDATE SET last_number = purchase_order_numbers.last_number + 1
       RETURNING last_number`,
      [organizationId],
    );
    const number = `PO-${String(numbered.rows[0].last_number).padStart(6, '0')}`;

    const created = await client.query<{ id: string }>(
      `INSERT INTO purchase_orders
         (organization_id, number, supplier_id, warehouse_id, expected_on, notes, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7)
       RETURNING id`,
      [
        organizationId,
        number,
        input.supplierId,
        input.warehouseId,
        input.expectedOn,
        input.notes,
        userId,
      ],
    );
    const orderId = created.rows[0].id;
    await this.insertLines(client, organizationId, orderId, input.lines, costs);
    const order = (await this.readOrder(client, organizationId, orderId)) as PurchaseOrder;
    await this.audit(client, organizationId, order, {
      action: 'purchase_order.created',
      actorId: userId,
      fromStatus: null,
      toStatus: null,
      reason: null,
      details: auditDetails,
    });
    return order;
  }

  /**
   * Replaces all lines of a draft. Returns null for an unknown order. The
   * order row is locked first, so a concurrent status change either happens
   * before (and the replacement is refused) or waits for this to commit.
   */
  async replaceLines(
    organizationId: string,
    orderId: string,
    lines: NewPurchaseOrderLine[],
    actorId: string,
  ): Promise<PurchaseOrder | null> {
    return this.transaction(async (client) => {
      const order = await client.query<{ status: PurchaseOrderStatus }>(
        `SELECT status FROM purchase_orders WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, orderId],
      );
      if (!order.rows[0]) return null;
      if (order.rows[0].status !== 'draft') {
        throw new PurchaseOrderNotEditableError(order.rows[0].status);
      }

      const costs = await this.lockSkus(client, organizationId, lines);
      await client.query(
        'DELETE FROM purchase_order_lines WHERE organization_id = $1 AND purchase_order_id = $2',
        [organizationId, orderId],
      );
      await this.insertLines(client, organizationId, orderId, lines, costs);
      await client.query(
        'UPDATE purchase_orders SET updated_at = now() WHERE organization_id = $1 AND id = $2',
        [organizationId, orderId],
      );
      const updated = (await this.readOrder(client, organizationId, orderId)) as PurchaseOrder;
      await this.audit(client, organizationId, updated, {
        action: 'purchase_order.lines_replaced',
        actorId,
        fromStatus: null,
        toStatus: null,
        reason: null,
      });
      return updated;
    });
  }

  /**
   * Moves an order to its next status and records the step in the audit
   * trail, in one transaction. The order row is locked first, so two people
   * acting at once are serialized and the second sees the new status (and
   * gets an InvalidTransitionError if their step no longer applies).
   * Returns null for an unknown order.
   */
  async transition(
    organizationId: string,
    orderId: string,
    input: TransitionInput,
  ): Promise<PurchaseOrder | null> {
    return this.transaction(async (client) => {
      const current = await client.query<{
        status: PurchaseOrderStatus;
        submitted_by: string | null;
      }>(
        `SELECT status, submitted_by FROM purchase_orders
          WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [organizationId, orderId],
      );
      const row = current.rows[0];
      if (!row) return null;

      const to = planTransition({
        action: input.action,
        from: row.status,
        actorId: input.actorId,
        actorRole: input.actorRole,
        submittedBy: row.submitted_by,
      });
      const { set, values } = transitionSet(input.action, input.actorId, input.reason);
      await client.query(
        `UPDATE purchase_orders SET status = $3${set ? `, ${set}` : ''}
          WHERE organization_id = $1 AND id = $2`,
        [organizationId, orderId, to, ...values],
      );

      const order = (await this.readOrder(client, organizationId, orderId)) as PurchaseOrder;
      await this.audit(client, organizationId, order, {
        action: AUDIT_ACTION[input.action],
        actorId: input.actorId,
        fromStatus: row.status,
        toStatus: to,
        reason: input.reason,
      });
      return order;
    });
  }

  /**
   * Books one delivery against an approved order, in one transaction:
   * the receipt and its lines, one `receipt` event per line in the inventory
   * ledger (so stock goes up), the lines' received totals, the order's next
   * status and an audit event. The order row is locked first, so concurrent
   * deliveries for the same order run one after the other and can never
   * receive more than was ordered between them.
   *
   * The Idempotency-Key is checked before anything else: a retry of a booked
   * delivery returns it unchanged (`replayed`), even if the order has since
   * been received in full. Returns null for an unknown order.
   */
  async receive(
    organizationId: string,
    orderId: string,
    actorId: string,
    idempotencyKey: string,
    input: NewReceipt,
  ): Promise<RecordedReceipt | null> {
    const hash = receiptHash(orderId, input);
    try {
      return await this.transaction(async (client) => {
        const current = await client.query<{
          status: PurchaseOrderStatus;
          number: string;
          warehouse_id: string;
        }>(
          `SELECT status, number, warehouse_id FROM purchase_orders
            WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [organizationId, orderId],
        );
        const order = current.rows[0];
        if (!order) return null;

        const previous = await client.query<ReceiptRow>(
          `${RECEIPT_SELECT} WHERE r.organization_id = $1 AND r.idempotency_key = $2`,
          [organizationId, idempotencyKey],
        );
        if (previous.rows[0]) {
          if (previous.rows[0].request_hash !== hash) {
            throw new IdempotencyConflictError(idempotencyKey);
          }
          const [receipt] = await this.readReceipts(client, organizationId, previous.rows);
          const unchanged = (await this.readOrder(client, organizationId, orderId)) as PurchaseOrder;
          return { receipt, order: unchanged, replayed: true };
        }

        const lines = await client.query<{
          id: string;
          line_number: number;
          sku_id: string;
          quantity_ordered: number;
          quantity_received: number;
        }>(
          `SELECT id, line_number, sku_id, quantity_ordered, quantity_received
             FROM purchase_order_lines
            WHERE organization_id = $1 AND purchase_order_id = $2
            ORDER BY line_number`,
          [organizationId, orderId],
        );
        const plan = planReceipt(
          order.status,
          lines.rows.map(
            (l): ReceivableLine => ({
              id: l.id,
              lineNumber: l.line_number,
              skuId: l.sku_id,
              quantityOrdered: l.quantity_ordered,
              quantityReceived: l.quantity_received,
            }),
          ),
          input.lines,
        );

        const inserted = await client.query<{ id: string; received_at: Date }>(
          `INSERT INTO purchase_order_receipts
             (organization_id, purchase_order_id, reference, notes, idempotency_key,
              request_hash, received_by, received_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
           RETURNING id, received_at`,
          [
            organizationId,
            orderId,
            input.reference,
            input.notes,
            idempotencyKey,
            hash,
            actorId,
            input.receivedAt,
          ],
        );
        const receiptId = inserted.rows[0].id;
        const occurredAt = inserted.rows[0].received_at.toISOString();

        for (const { line, quantity } of plan.lines) {
          const movement = {
            skuId: line.skuId,
            warehouseId: order.warehouse_id,
            type: 'receipt' as const,
            quantityDelta: quantity,
            reason: null,
            reference: order.number,
            correctsEventId: null,
            occurredAt,
          };
          const event = await client.query<{ id: string }>(
            `INSERT INTO inventory_events
               (organization_id, sku_id, warehouse_id, event_type, quantity_delta, reference,
                idempotency_key, request_hash, created_by, occurred_at)
             VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7, $8, $9)
             RETURNING id`,
            [
              organizationId,
              line.skuId,
              order.warehouse_id,
              quantity,
              order.number,
              receiptEventKey(receiptId, line.lineNumber),
              movementHash(movement),
              actorId,
              occurredAt,
            ],
          );
          await client.query(
            `INSERT INTO purchase_order_receipt_lines
               (organization_id, receipt_id, purchase_order_line_id, quantity, inventory_event_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [organizationId, receiptId, line.id, quantity, event.rows[0].id],
          );
          await client.query(
            `UPDATE purchase_order_lines SET quantity_received = quantity_received + $3
              WHERE organization_id = $1 AND id = $2`,
            [organizationId, line.id, quantity],
          );
        }

        const statusChanged = plan.nextStatus !== order.status;
        await client.query(
          `UPDATE purchase_orders SET status = $3, updated_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [organizationId, orderId, plan.nextStatus],
        );

        const updated = (await this.readOrder(client, organizationId, orderId)) as PurchaseOrder;
        await this.audit(client, organizationId, updated, {
          action: 'purchase_order.goods_received',
          actorId,
          fromStatus: statusChanged ? order.status : null,
          toStatus: statusChanged ? plan.nextStatus : null,
          reason: null,
          details: {
            receiptId,
            unitsReceived: plan.units,
            receiptLineCount: plan.lines.length,
            totalUnitsReceived: updated.totalUnitsReceived,
          },
        });

        const created = await client.query<ReceiptRow>(
          `${RECEIPT_SELECT} WHERE r.organization_id = $1 AND r.id = $2`,
          [organizationId, receiptId],
        );
        const [receipt] = await this.readReceipts(client, organizationId, created.rows);
        return { receipt, order: updated, replayed: false };
      });
    } catch (error) {
      const { code, constraint } = pgError(error);
      // The same key used at the same moment for another order's delivery.
      if (code === UNIQUE_VIOLATION && constraint === RECEIPT_KEY_CONSTRAINT) {
        throw new IdempotencyConflictError(idempotencyKey);
      }
      if (code === NUMERIC_VALUE_OUT_OF_RANGE) throw new StockOverflowError();
      throw error;
    }
  }

  /** The order's receipts, oldest first; null for an unknown order. */
  async listReceipts(organizationId: string, orderId: string): Promise<Receipt[] | null> {
    const exists = await this.pool.query(
      'SELECT 1 FROM purchase_orders WHERE organization_id = $1 AND id = $2',
      [organizationId, orderId],
    );
    if (!exists.rows[0]) return null;
    const { rows } = await this.pool.query<ReceiptRow>(
      `${RECEIPT_SELECT} WHERE r.organization_id = $1 AND r.purchase_order_id = $2
        ORDER BY r.recorded_at, r.id`,
      [organizationId, orderId],
    );
    return this.readReceipts(this.pool, organizationId, rows);
  }

  /** The receipts' lines (with line number and SKU code), attached in order. */
  private async readReceipts(
    db: Queryable,
    organizationId: string,
    receipts: ReceiptRow[],
  ): Promise<Receipt[]> {
    if (receipts.length === 0) return [];
    const { rows } = await db.query<ReceiptLineRow>(
      `SELECT rl.receipt_id, rl.purchase_order_line_id, l.line_number, l.sku_id,
              k.code AS sku_code, rl.quantity, rl.inventory_event_id
         FROM purchase_order_receipt_lines rl
         JOIN purchase_order_lines l
           ON l.organization_id = rl.organization_id AND l.id = rl.purchase_order_line_id
         JOIN skus k ON k.organization_id = l.organization_id AND k.id = l.sku_id
        WHERE rl.organization_id = $1 AND rl.receipt_id = ANY($2::uuid[])
        ORDER BY l.line_number`,
      [organizationId, receipts.map((r) => r.id)],
    );
    return receipts.map((r) => toReceipt(r, rows));
  }

  /** The order's audit trail, oldest first; null for an unknown order. */
  async listEvents(organizationId: string, orderId: string): Promise<AuditEvent[] | null> {
    const exists = await this.pool.query(
      'SELECT 1 FROM purchase_orders WHERE organization_id = $1 AND id = $2',
      [organizationId, orderId],
    );
    if (!exists.rows[0]) return null;
    const { rows } = await this.pool.query<AuditEventRow>(
      `SELECT id, entity_type, entity_id, action, actor_id, from_status, to_status, reason,
              details, occurred_at
         FROM audit_events
        WHERE organization_id = $1 AND entity_type = 'purchase_order' AND entity_id = $2
        ORDER BY occurred_at, id`,
      [organizationId, orderId],
    );
    return rows.map(toAuditEvent);
  }

  /** Appends one audit event for the order, with its number and totals as details. */
  private async audit(
    client: Queryable,
    organizationId: string,
    order: PurchaseOrder,
    event: {
      action: string;
      actorId: string;
      fromStatus: PurchaseOrderStatus | null;
      toStatus: PurchaseOrderStatus | null;
      reason: string | null;
      details?: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (organization_id, entity_type, entity_id, action, actor_id, from_status, to_status,
          reason, details)
       VALUES ($1, 'purchase_order', $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        organizationId,
        order.id,
        event.action,
        event.actorId,
        event.fromStatus,
        event.toStatus,
        event.reason,
        JSON.stringify({
          number: order.number,
          lineCount: order.lineCount,
          totalCents: order.totalCents,
          ...event.details,
        }),
      ],
    );
  }

  /**
   * Current catalog cost of every SKU on the lines. Each SKU must be an
   * active SKU of the organization; the first one that isn't is reported by
   * its line index.
   */
  private async lockSkus(
    client: Queryable,
    organizationId: string,
    lines: NewPurchaseOrderLine[],
  ): Promise<Map<string, number>> {
    const { rows } = await client.query<{ id: string; unit_cost_cents: number }>(
      `SELECT id, unit_cost_cents FROM skus
        WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL
        FOR SHARE`,
      [organizationId, lines.map((l) => l.skuId)],
    );
    const costs = new Map(rows.map((r) => [r.id, r.unit_cost_cents]));
    const missing = lines.findIndex((l) => !costs.has(l.skuId));
    if (missing >= 0) throw new UnknownReferenceError(`lines[${missing}].skuId`);
    return costs;
  }

  private async insertLines(
    client: Queryable,
    organizationId: string,
    orderId: string,
    lines: NewPurchaseOrderLine[],
    costs: Map<string, number>,
  ): Promise<void> {
    try {
      await client.query(
        `INSERT INTO purchase_order_lines
           (organization_id, purchase_order_id, line_number, sku_id, quantity_ordered,
            unit_cost_cents)
         SELECT $1, $2, l.line_number, l.sku_id, l.quantity, l.unit_cost_cents
           FROM unnest($3::smallint[], $4::uuid[], $5::integer[], $6::integer[])
                AS l(line_number, sku_id, quantity, unit_cost_cents)`,
        [
          organizationId,
          orderId,
          lines.map((_, i) => i + 1),
          lines.map((l) => l.skuId),
          lines.map((l) => l.quantity),
          lines.map((l) => l.unitCostCents ?? (costs.get(l.skuId) as number)),
        ],
      );
    } catch (error) {
      const { code, constraint } = pgError(error);
      if (code === CHECK_VIOLATION && constraint === LINE_TOTAL_CONSTRAINT) {
        throw new LineTotalTooLargeError();
      }
      throw error;
    }
  }

  private async readOrder(
    db: Queryable,
    organizationId: string,
    id: string,
  ): Promise<PurchaseOrder | null> {
    const header = await db.query<PurchaseOrderRow>(`${ORDER_SELECT} AND po.id = $2`, [
      organizationId,
      id,
    ]);
    if (!header.rows[0]) return null;
    const lines = await db.query<PurchaseOrderLineRow>(
      `SELECT l.id, l.line_number, l.sku_id, k.code AS sku_code, k.name AS sku_name, k.unit,
              l.quantity_ordered, l.quantity_received, l.unit_cost_cents, l.line_total_cents
         FROM purchase_order_lines l
         JOIN skus k ON k.organization_id = l.organization_id AND k.id = l.sku_id
        WHERE l.organization_id = $1 AND l.purchase_order_id = $2
        ORDER BY l.line_number`,
      [organizationId, id],
    );
    return { ...toPurchaseOrderSummary(header.rows[0]), lines: lines.rows.map(toPurchaseOrderLine) };
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
