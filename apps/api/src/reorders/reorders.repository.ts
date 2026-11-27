import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { UnknownReferenceError } from '../catalog/catalog.repository';
import { PG_POOL } from '../database/database.module';
import type { PurchaseOrder } from '../purchasing/purchasing.models';
import { PurchasingRepository, type Queryable } from '../purchasing/purchasing.repository';
import {
  toReorderProposal,
  type DecisionInput,
  type ReorderProposal,
  type ReorderProposalQuery,
  type ReorderProposalRow,
  type ReorderProposalStatus,
  type ReorderRunResult,
  type WorkerCandidates,
} from './reorders.models';

/** The proposal was already decided or replaced, so it can't be decided now. */
export class ProposalNotPendingError extends Error {
  constructor(readonly status: ReorderProposalStatus) {
    super(`Only pending proposals can be decided (status: ${status})`);
    this.name = 'ProposalNotPendingError';
  }
}

/** The SKU, warehouse or supplier was archived after the proposal was made. */
export class ProposalOutdatedError extends Error {
  constructor(readonly field: string) {
    super(`The proposal's ${field.replace(/Id$/, '')} is no longer active; run reorders again`);
    this.name = 'ProposalOutdatedError';
  }
}

const PROPOSAL_SELECT = `SELECT p.id, p.organization_id, p.status,
       p.sku_id, k.code::text AS sku_code, k.name AS sku_name, k.unit,
       p.warehouse_id, w.code::text AS warehouse_code,
       p.supplier_id, s.code::text AS supplier_code,
       p.suggested_qty, p.on_hand, p.on_order, p.reorder_point, p.safety_stock, p.order_up_to,
       p.evidence, p.warnings, p.inputs_digest, p.calculated_at, p.created_by,
       p.decided_by, p.decided_at, p.decision_reason, p.approved_qty,
       p.purchase_order_id, po.number AS purchase_order_number, p.superseded_at,
       p.created_at, p.updated_at
  FROM reorder_proposals p
  JOIN skus k ON k.organization_id = p.organization_id AND k.id = p.sku_id
  JOIN warehouses w ON w.organization_id = p.organization_id AND w.id = p.warehouse_id
  JOIN suppliers s ON s.organization_id = p.organization_id AND s.id = p.supplier_id
  LEFT JOIN purchase_orders po
    ON po.organization_id = p.organization_id AND po.id = p.purchase_order_id
 WHERE p.organization_id = $1`;

/**
 * Reorder proposals. Every query is scoped by organization id.
 *
 * A run stores the worker's candidates in one transaction, serialized per
 * organization by an advisory lock: unchanged open proposals stay, changed
 * ones are superseded by a new proposal, and open proposals the run no longer
 * recommends are superseded. A decision locks the proposal row, so a decision
 * and a run (or two decisions) never both act on the same open proposal.
 */
@Injectable()
export class ReordersRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pick<Pool, 'query' | 'connect'>,
    private readonly purchasing: PurchasingRepository,
  ) {}

  async list(
    organizationId: string,
    query: ReorderProposalQuery,
  ): Promise<{ proposals: ReorderProposal[]; hasMore: boolean }> {
    const { rows } = await this.pool.query<ReorderProposalRow>(
      `${PROPOSAL_SELECT}
         AND ($2::text IS NULL OR p.status = $2)
         AND ($3::uuid IS NULL OR p.sku_id = $3)
         AND ($4::uuid IS NULL OR p.warehouse_id = $4)
       ORDER BY p.created_at DESC, p.id
       LIMIT $5 OFFSET $6`,
      [organizationId, query.status, query.skuId, query.warehouseId, query.limit + 1, query.offset],
    );
    return {
      proposals: rows.slice(0, query.limit).map(toReorderProposal),
      hasMore: rows.length > query.limit,
    };
  }

  async find(organizationId: string, id: string): Promise<ReorderProposal | null> {
    return this.read(this.pool, organizationId, id);
  }

  /** Stores one run's candidates; `actorId` is the manager who started the run. */
  async applyRun(
    organizationId: string,
    actorId: string,
    run: WorkerCandidates,
  ): Promise<ReorderRunResult> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('reorder_run:' || $1, 0))", [
        organizationId,
      ]);
      const open = await client.query<{
        id: string;
        sku_id: string;
        warehouse_id: string;
        supplier_id: string;
        inputs_digest: string;
      }>(
        `SELECT id, sku_id, warehouse_id, supplier_id, inputs_digest
           FROM reorder_proposals
          WHERE organization_id = $1 AND status = 'pending'
          FOR UPDATE`,
        [organizationId],
      );
      const openByPair = new Map(open.rows.map((r) => [`${r.sku_id}/${r.warehouse_id}`, r]));

      let created = 0;
      let unchanged = 0;
      const supersede: { id: string; reason: string }[] = [];
      const inserts: WorkerCandidates['candidates'] = [];
      for (const candidate of run.candidates) {
        const pair = `${candidate.skuId}/${candidate.warehouseId}`;
        const current = openByPair.get(pair);
        openByPair.delete(pair);
        if (current && current.inputs_digest === candidate.digest && current.supplier_id === candidate.supplierId) {
          unchanged += 1;
          continue;
        }
        if (current) supersede.push({ id: current.id, reason: 'replaced' });
        inserts.push(candidate);
      }
      for (const left of openByPair.values()) supersede.push({ id: left.id, reason: 'no_longer_recommended' });

      for (const { id, reason } of supersede) {
        const { rows } = await client.query<{ sku_id: string }>(
          `UPDATE reorder_proposals SET status = 'superseded', superseded_at = now()
            WHERE organization_id = $1 AND id = $2 AND status = 'pending'
            RETURNING sku_id`,
          [organizationId, id],
        );
        if (rows[0]) {
          await this.audit(client, organizationId, id, actorId, 'reorder_proposal.superseded', {
            fromStatus: 'pending',
            toStatus: 'superseded',
            details: { why: reason },
          });
        }
      }

      for (const c of inserts) {
        // Left out rather than failing the run: pairs whose SKU, warehouse or
        // supplier was archived, and pairs a manager approved while the worker
        // was calculating (the new draft order isn't in the worker's numbers).
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO reorder_proposals
             (organization_id, sku_id, warehouse_id, supplier_id, suggested_qty, on_hand, on_order,
              reorder_point, safety_stock, order_up_to, evidence, warnings, inputs_digest,
              calculated_at, created_by)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::text[], $13, $14, $15
            WHERE EXISTS (SELECT 1 FROM skus WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL)
              AND EXISTS (SELECT 1 FROM warehouses WHERE organization_id = $1 AND id = $3 AND archived_at IS NULL)
              AND EXISTS (SELECT 1 FROM suppliers WHERE organization_id = $1 AND id = $4 AND archived_at IS NULL)
              AND NOT EXISTS (SELECT 1 FROM reorder_proposals
                               WHERE organization_id = $1 AND sku_id = $2 AND warehouse_id = $3
                                 AND status = 'approved' AND decided_at >= $14)
           RETURNING id`,
          [
            organizationId,
            c.skuId,
            c.warehouseId,
            c.supplierId,
            c.suggestedQty,
            c.onHand,
            c.onOrder,
            c.reorderPoint,
            c.safetyStock,
            c.orderUpTo,
            JSON.stringify(c.evidence),
            c.warnings,
            c.digest,
            run.calculatedAt,
            actorId,
          ],
        );
        if (!rows[0]) {
          run.skipped.push({
            skuId: c.skuId,
            skuCode: c.skuId,
            warehouseId: c.warehouseId,
            warehouseCode: c.warehouseId,
            reason: 'changed_during_run',
          });
          continue;
        }
        created += 1;
        await this.audit(client, organizationId, rows[0].id, actorId, 'reorder_proposal.created', {
          fromStatus: null,
          toStatus: null,
          details: { suggestedQty: c.suggestedQty, reorderPoint: c.reorderPoint },
        });
      }

      return {
        calculatedAt: run.calculatedAt,
        parameters: run.parameters,
        created,
        unchanged,
        superseded: supersede.length,
        skipped: run.skipped,
      };
    });
  }

  /**
   * Approves or rejects an open proposal. Approving raises a draft purchase
   * order for the preferred supplier in the same transaction; the order then
   * needs the usual submit and approve steps. Returns null for an unknown id.
   */
  async decide(
    organizationId: string,
    id: string,
    actorId: string,
    input: DecisionInput,
  ): Promise<{ proposal: ReorderProposal; purchaseOrder: PurchaseOrder | null } | null> {
    return this.transaction(async (client) => {
      const locked = await client.query<{
        status: ReorderProposalStatus;
        sku_id: string;
        warehouse_id: string;
        supplier_id: string;
        suggested_qty: number;
      }>(
        `SELECT status, sku_id, warehouse_id, supplier_id, suggested_qty
           FROM reorder_proposals
          WHERE organization_id = $1 AND id = $2
          FOR UPDATE`,
        [organizationId, id],
      );
      const row = locked.rows[0];
      if (!row) return null;
      if (row.status !== 'pending') throw new ProposalNotPendingError(row.status);

      let purchaseOrder: PurchaseOrder | null = null;
      if (input.decision === 'approve') {
        const quantity = input.quantity ?? row.suggested_qty;
        try {
          purchaseOrder = await this.purchasing.createOrderIn(
            client,
            organizationId,
            actorId,
            {
              supplierId: row.supplier_id,
              warehouseId: row.warehouse_id,
              expectedOn: input.expectedOn,
              notes: input.reason ?? 'Raised from a reorder proposal',
              lines: [{ skuId: row.sku_id, quantity, unitCostCents: null }],
            },
            { reorderProposalId: id },
          );
        } catch (error) {
          if (error instanceof UnknownReferenceError) {
            throw new ProposalOutdatedError(error.field.startsWith('lines') ? 'skuId' : error.field);
          }
          throw error;
        }
        await client.query(
          `UPDATE reorder_proposals
              SET status = 'approved', decided_by = $3, decided_at = now(), decision_reason = $4,
                  approved_qty = $5, purchase_order_id = $6
            WHERE organization_id = $1 AND id = $2`,
          [organizationId, id, actorId, input.reason, quantity, purchaseOrder.id],
        );
        await this.audit(client, organizationId, id, actorId, 'reorder_proposal.approved', {
          fromStatus: 'pending',
          toStatus: 'approved',
          reason: input.reason,
          details: {
            suggestedQty: row.suggested_qty,
            approvedQty: quantity,
            purchaseOrderId: purchaseOrder.id,
            purchaseOrderNumber: purchaseOrder.number,
          },
        });
      } else {
        await client.query(
          `UPDATE reorder_proposals
              SET status = 'rejected', decided_by = $3, decided_at = now(), decision_reason = $4
            WHERE organization_id = $1 AND id = $2`,
          [organizationId, id, actorId, input.reason],
        );
        await this.audit(client, organizationId, id, actorId, 'reorder_proposal.rejected', {
          fromStatus: 'pending',
          toStatus: 'rejected',
          reason: input.reason,
          details: { suggestedQty: row.suggested_qty },
        });
      }
      const proposal = (await this.read(client, organizationId, id)) as ReorderProposal;
      return { proposal, purchaseOrder };
    });
  }

  private async audit(
    client: Queryable,
    organizationId: string,
    proposalId: string,
    actorId: string,
    action: string,
    event: {
      fromStatus: ReorderProposalStatus | null;
      toStatus: ReorderProposalStatus | null;
      reason?: string | null;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
         (organization_id, entity_type, entity_id, action, actor_id, from_status, to_status,
          reason, details)
       VALUES ($1, 'reorder_proposal', $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        organizationId,
        proposalId,
        action,
        actorId,
        event.fromStatus,
        event.toStatus,
        event.reason ?? null,
        JSON.stringify(event.details),
      ],
    );
  }

  private async read(db: Queryable, organizationId: string, id: string): Promise<ReorderProposal | null> {
    const { rows } = await db.query<ReorderProposalRow>(`${PROPOSAL_SELECT} AND p.id = $2`, [
      organizationId,
      id,
    ]);
    return rows[0] ? toReorderProposal(rows[0]) : null;
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
